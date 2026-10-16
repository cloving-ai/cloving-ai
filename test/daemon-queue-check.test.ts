import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import { eventually, withHarness } from "./service-fixture.ts";

function result(fields: Fields): Reply {
  return { kind: "result", result: fields };
}

const empty: Reply = {
  kind: "error",
  error: { code: "no-ready-ticket", detail: "No ready ticket." },
};

async function withQueue(
  options: {
    readonly handle: Handle;
    readonly commands?: readonly string[];
    readonly intervalMilliseconds?: number;
  },
  body: (scene: {
    readonly commands: () => Promise<readonly string[]>;
    readonly stop: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  return withHarness(async (harness) => {
    const directory = harness.stateDirectory;
    const file = join(directory, "queue-commands.json");
    await writeFile(file, JSON.stringify(options.commands ?? []));
    const listener = await listen({
      path: join(harness.runtimeDirectory, "control.sock"),
      handle: options.handle,
      limits: { idleMilliseconds: 5000 },
    });
    const queue = issueQueue({
      directory,
      runtimeDirectory: harness.runtimeDirectory,
      intervalMilliseconds: options.intervalMilliseconds ?? 5,
    });
    try {
      await body({
        commands: async (): Promise<readonly string[]> => {
          const value: unknown = JSON.parse(await readFile(file, "utf8"));
          assert.ok(Array.isArray(value));
          assert.ok(value.every((id): id is string => typeof id === "string"));
          return value;
        },
        stop: queue.stop,
      });
    } finally {
      await queue.stop();
      await listener.close();
    }
  });
}

function changingRun(counts: { reads: number; submissions: number }): Handle {
  const runId = runIdentity("prior-command");
  return (request) => {
    if (request.operation === "run") {
      counts.submissions += 1;
      return Promise.resolve(empty);
    }
    if (request.parameters["runId"] !== undefined) {
      counts.reads += 1;
      return Promise.resolve(
        result({
          run: {
            runId,
            state: counts.reads <= 2 ? "running" : "completed",
            outcome: { kind: "blocked" },
          },
        }),
      );
    }
    return Promise.resolve(
      result({
        runs: [{ runId, workflowId: "develop-issue", state: "completed" }],
        next: null,
      }),
    );
  };
}

await test("CLV-084 a tracked run ending between status reads cannot admit another ticket before its outcome is checked", async () => {
  const counts = { reads: 0, submissions: 0 };
  await withQueue(
    { commands: ["prior-command"], handle: changingRun(counts) },
    async (scene) => {
      await eventually(() => (counts.reads >= 3 ? true : undefined));
      await scene.stop();
      assert.equal(counts.submissions, 0);
      assert.deepEqual(await scene.commands(), []);
    },
  );
});

await test("CLV-084 failed and cancelled tracked runs stop the queue and retire their commands", async () => {
  for (const state of ["failed", "cancelled"]) {
    let reads = 0;
    let submissions = 0;
    await withQueue(
      {
        commands: [state],
        handle: (request) => {
          if (request.operation === "run") submissions += 1;
          reads += 1;
          return Promise.resolve(
            result({
              run: { runId: runIdentity(state), state, outcome: null },
            }),
          );
        },
      },
      async (scene) => {
        await eventually(() => (reads >= 2 ? true : undefined));
        await scene.stop();
        assert.equal(submissions, 0);
        assert.deepEqual(await scene.commands(), []);
      },
    );
  }
});

function pagedRuns(tracking: { pages: string[]; submissions: number }): Handle {
  return (request) => {
    if (request.operation === "run") {
      tracking.submissions += 1;
      return Promise.resolve(empty);
    }
    const after = request.parameters["after"];
    assert.ok(typeof after === "string");
    tracking.pages.push(after);
    return Promise.resolve(
      result(
        after === ""
          ? {
              runs: [
                {
                  runId: "first",
                  workflowId: "develop-issue",
                  state: "completed",
                },
              ],
              next: "first",
            }
          : {
              runs: [
                { runId: "last", workflowId: "develop-issue", state: "paused" },
              ],
              next: null,
            },
      ),
    );
  };
}

await test("CLV-084 a later page containing an active issue holds the queue", async () => {
  const pages: string[] = [];
  const tracking = { pages, submissions: 0 };
  await withQueue({ handle: pagedRuns(tracking) }, async (scene) => {
    await eventually(() => (pages.includes("first") ? true : undefined));
    await scene.stop();
    assert.equal(tracking.submissions, 0);
  });
});

function heldSubmission(tracking: {
  submissions: number;
  readonly released: Promise<undefined>;
}): Handle {
  return async (request) => {
    if (request.operation !== "run") return result({ runs: [], next: null });
    tracking.submissions += 1;
    await tracking.released;
    return empty;
  };
}

await test("CLV-084 checks do not overlap a pending submission and shutdown waits for it to retire", async () => {
  const released = Promise.withResolvers<undefined>();
  const tracking = { submissions: 0, released: released.promise };
  await withQueue({ handle: heldSubmission(tracking) }, async (scene) => {
    try {
      await eventually(() => (tracking.submissions === 1 ? true : undefined));
      await delay(50);
      assert.equal(tracking.submissions, 1);
      const stopping = scene.stop();
      released.resolve(undefined);
      await stopping;
      assert.deepEqual(await scene.commands(), []);
    } finally {
      released.resolve(undefined);
    }
  });
});

const timeout: Reply = {
  kind: "error",
  error: { code: "resolver-timeout", detail: "Retry the same command." },
};

function retryScene() {
  const submissions: {
    readonly request: ServiceRequest;
    readonly receivedAt: number;
    readonly reply: ReturnType<typeof Promise.withResolvers<Reply>>;
  }[] = [];
  const status: { run?: Fields; runs: Fields[]; reads: number; scans: number } =
    {
      runs: [],
      reads: 0,
      scans: 0,
    };
  const handle: Handle = async (request) => {
    if (request.operation === "run") {
      const reply = Promise.withResolvers<Reply>();
      submissions.push({ request, receivedAt: performance.now(), reply });
      return reply.promise;
    }
    if (request.parameters["runId"] !== undefined) {
      status.reads += 1;
      return status.run
        ? result({ run: status.run })
        : {
            kind: "error",
            error: { code: "unknown-run", detail: "Not admitted." },
          };
    }
    status.scans += 1;
    return result({ runs: status.runs, next: null });
  };
  return {
    submissions,
    status,
    handle,
    release: () => {
      for (const submission of submissions) submission.reply.resolve(empty);
    },
  };
}

await test("CLV-092 repeated timeouts wait a full cycle, reuse the request and track only the admitted run", async () => {
  const retry = retryScene();
  const intervalMilliseconds = 80;
  await withQueue(
    { handle: retry.handle, intervalMilliseconds },
    async (scene) => {
      try {
        let repliedAt = 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const submission = await eventually(() => retry.submissions[attempt]);
          const original = retry.submissions[0]?.request;
          assert.ok(original);
          assert.deepEqual(submission.request, original);
          assert.deepEqual(original, {
            operation: "run",
            parameters: {
              workflowId: "develop-issue",
              source: "ticket",
              submission: { ticket: "next" },
              commandId: original.parameters["commandId"],
            },
          });
          assert.deepEqual(await scene.commands(), [
            original.parameters["commandId"],
          ]);
          assert.equal(retry.status.reads, 0);
          assert.ok(
            submission.receivedAt - repliedAt >= intervalMilliseconds - 1,
          );
          await delay(intervalMilliseconds * 2);
          assert.equal(retry.submissions.length, attempt + 1);
          repliedAt = performance.now();
          if (attempt < 2) submission.reply.resolve(timeout);
          else {
            retry.status.run = { state: "running" };
            submission.reply.resolve(result({ kind: "run-admitted" }));
          }
        }
        await eventually(() => (retry.status.reads >= 2 ? true : undefined));
        assert.equal(retry.submissions.length, 3);
        retry.status.run = {
          state: "completed",
          outcome: { kind: "handoff_requested" },
        };
        const next = await eventually(() => retry.submissions[3]);
        assert.notEqual(
          next.request.parameters["commandId"],
          retry.submissions[0]?.request.parameters["commandId"],
        );
        assert.deepEqual(await scene.commands(), [
          next.request.parameters["commandId"],
        ]);
      } finally {
        retry.release();
      }
    },
  );
});

await test("CLV-092 an active issue defers a pending retry and preserves its request", async () => {
  const retry = retryScene();
  await withQueue(
    { handle: retry.handle, intervalMilliseconds: 40 },
    async (scene) => {
      try {
        const first = await eventually(() => retry.submissions[0]);
        retry.status.runs = [{ workflowId: "develop-issue", state: "running" }];
        first.reply.resolve(timeout);
        const priorScans = retry.status.scans;
        await eventually(() =>
          retry.status.scans >= priorScans + 2 ? true : undefined,
        );
        assert.equal(retry.submissions.length, 1);
        assert.equal(retry.status.reads, 0);
        assert.deepEqual(await scene.commands(), [
          first.request.parameters["commandId"],
        ]);
        retry.status.runs = [
          { workflowId: "develop-issue", state: "completed" },
        ];
        const second = await eventually(() => retry.submissions[1]);
        assert.deepEqual(second.request, first.request);
        assert.deepEqual(await scene.commands(), [
          first.request.parameters["commandId"],
        ]);
      } finally {
        retry.release();
      }
    },
  );
});

await test("CLV-092 stopping after a timeout prevents its pending retry", async () => {
  const retry = retryScene();
  await withQueue(
    { handle: retry.handle, intervalMilliseconds: 80 },
    async (scene) => {
      const first = await eventually(() => retry.submissions[0]);
      first.reply.resolve(timeout);
      await delay(30);
      await scene.stop();
      await delay(100);
      assert.equal(retry.submissions.length, 1);
      assert.deepEqual(await scene.commands(), [
        first.request.parameters["commandId"],
      ]);
    },
  );
});
