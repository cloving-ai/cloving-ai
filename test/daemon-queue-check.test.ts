import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import type { Fields, Reply } from "../src/protocol.ts";
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
  options: { readonly handle: Handle; readonly commands?: readonly string[] },
  body: (scene: {
    readonly commands: () => Promise<unknown>;
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
      intervalMilliseconds: 5,
    });
    try {
      await body({
        commands: async (): Promise<unknown> =>
          JSON.parse(await readFile(file, "utf8")),
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

function pagedRuns(tracking: {
  pages: unknown[];
  submissions: number;
}): Handle {
  return (request) => {
    if (request.operation === "run") {
      tracking.submissions += 1;
      return Promise.resolve(empty);
    }
    const after = request.parameters["after"];
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
  const tracking = { pages: [], submissions: 0 };
  const pages: unknown[] = tracking.pages;
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
