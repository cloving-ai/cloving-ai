import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, ServiceRequest } from "../src/protocol.ts";
import type { Handle } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";
import {
  blockedRun,
  notifyReply,
  notificationJournal,
  withNotifier,
} from "./notify-check-fixture.ts";

function pagedRuns(pages: unknown[]): Handle {
  return (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    if (request.parameters["runId"] !== undefined)
      return notifyReply({ run: blockedRun });
    const after = request.parameters["after"];
    pages.push(after);
    return notifyReply(
      after === ""
        ? { runs: [], next: "page-two" }
        : { runs: [blockedRun], next: null },
    );
  };
}

function failingScans(counts: { reads: number }): Handle {
  const invalid = [
    { kind: "error", error: { code: "unavailable", detail: "unavailable" } },
    notifyReply({ runs: null }),
    notifyReply({ runs: [null] }),
    notifyReply({ runs: [], next: "" }),
    notifyReply({ runs: [], next: 7 }),
  ] as const;
  return (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    if (request.parameters["runId"] !== undefined)
      return notifyReply({ run: blockedRun });
    return Promise.resolve(
      invalid[counts.reads++] ??
        notifyReply({ runs: [blockedRun], next: null }),
    );
  };
}

function changingRuns(state: { ready: boolean }): Handle {
  return (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    if (request.parameters["runId"] !== undefined)
      return notifyReply({ run: blockedRun });
    return notifyReply({ runs: state.ready ? [blockedRun] : [], next: null });
  };
}

function historyRuns(state: {
  readonly requests: ServiceRequest[];
  readonly runs: Fields[];
  readonly decisions?: readonly Fields[];
}): Handle {
  return (request) => {
    state.requests.push(request);
    if (request.operation === "questions")
      return notifyReply({ decisions: state.decisions ?? [] });
    const runId = request.parameters["runId"];
    if (runId !== undefined)
      return notifyReply({
        run: state.runs.find((run) => run["runId"] === runId),
      });
    return notifyReply({ runs: state.runs, next: null });
  };
}

function heldScan(
  release: Promise<undefined>,
  counts: { reads: number },
): Handle {
  return async (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    counts.reads += 1;
    await release;
    return notifyReply({ runs: [], next: null });
  };
}

function unavailableQuestions(counts: {
  statuses: number;
  questions: number;
}): Handle {
  return (request) => {
    if (request.operation === "questions") {
      counts.questions += 1;
      if (counts.questions === 1)
        return Promise.resolve({
          kind: "error",
          error: { code: "unavailable", detail: "unavailable" },
        });
      return notifyReply({ decisions: [] });
    }
    if (request.parameters["runId"] !== undefined) {
      counts.statuses += 1;
      return notifyReply({ run: blockedRun });
    }
    return notifyReply({ runs: [blockedRun], next: null });
  };
}

for (const latestSequence of [undefined, null, "1", true, {}, []]) {
  await test(`CLV-090 notification checks reject invalid sequence ${JSON.stringify(latestSequence)} and recover`, async () => {
    const state = {
      requests: [] as ServiceRequest[],
      runs: [{ ...blockedRun, latestSequence }] as Fields[],
    };
    await withNotifier({ handle: historyRuns(state) }, async (scene) => {
      await eventually(() => (state.requests.length >= 3 ? true : undefined));
      assert.equal(
        state.requests.filter(
          (request) => request.parameters["runId"] !== undefined,
        ).length,
        0,
      );
      assert.deepEqual(await scene.notices(), []);
      assert.deepEqual(await notificationJournal(scene.directory), {
        version: 1,
        entries: [],
      });
      state.runs = [blockedRun];
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      assert.equal((await scene.notices())[0]?.["event"], "blocked");
      assert.equal(
        state.requests.filter(
          (request) => request.parameters["runId"] !== undefined,
        ).length,
        1,
      );
    });
  });
}

await test("CLV-090 notification checks skip unchanged history and read questions once per check", async () => {
  const state = {
    requests: [] as ServiceRequest[],
    runs: [
      { ...blockedRun, latestSequence: 1 },
      {
        ...blockedRun,
        runId: "run-successful",
        latestSequence: 2,
        outcome: { kind: "handoff_requested" },
      },
    ],
  };
  await withNotifier(
    { handle: historyRuns(state), record: '["blocked:run-blocked"]' },
    async (scene) => {
      await eventually(() =>
        state.requests.filter((request) => request.operation === "questions")
          .length >= 3
          ? true
          : undefined,
      );
      await scene.stop();
      const statuses = state.requests.filter(
        (request) => request.operation === "status",
      );
      assert.deepEqual(
        statuses
          .filter((request) => request.parameters["runId"] !== undefined)
          .map((request) => request.parameters["runId"]),
        ["run-blocked", "run-successful"],
      );
      const questions = state.requests.filter(
        (request) => request.operation === "questions",
      );
      assert.equal(
        questions.length,
        statuses.filter((request) => request.parameters["runId"] === undefined)
          .length,
      );
      assert.ok(
        questions.every(
          (request) => Object.keys(request.parameters).length === 0,
        ),
      );
      assert.deepEqual(await scene.notices(), []);
    },
  );
});

await test("CLV-090 sequence changes refresh outcomes and cached runs still supply new decisions", async () => {
  const state = {
    requests: [] as ServiceRequest[],
    runs: [{ ...blockedRun, state: "running", latestSequence: 1 }] as Fields[],
    decisions: [] as Fields[],
  };
  await withNotifier(
    {
      handle: historyRuns(state),
      script: `
import { appendFileSync } from "node:fs";
let text = "";
for await (const chunk of process.stdin) text += chunk;
appendFileSync("notifications", text);
`,
    },
    async (scene) => {
      await eventually(() => (state.requests.length >= 5 ? true : undefined));
      state.decisions = [
        {
          decisionId: "run-blocked/review",
          runId: blockedRun.runId,
          type: "approval",
          prompt: "Review this change",
          allowed: ["approve", "deny"],
        },
      ];
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      state.decisions = [];
      state.runs = [{ ...blockedRun, latestSequence: 2 }];
      await eventually(async () =>
        (await scene.notices()).length === 2 ? true : undefined,
      );
      await scene.stop();
      const notices = await scene.notices();
      assert.deepEqual(
        notices.map((notice) => notice["event"]),
        ["decision", "blocked"],
      );
      assert.equal(notices[0]?.["workflowId"], "develop-ticket");
      assert.match(
        String(notices[0]["body"]),
        /cloving approve run-blocked\/review/,
      );
      assert.match(
        String(notices[0]["body"]),
        /cloving deny run-blocked\/review/,
      );
      assert.match(String(notices[1]?.["body"]), /needs help/);
      assert.equal(
        state.requests.filter(
          (request) => request.parameters["runId"] !== undefined,
        ).length,
        2,
      );
    },
  );
});

await test("CLV-090 the notifier reads every page and records the event before running the command without added arguments", async () => {
  const pages: unknown[] = [];
  await withNotifier(
    {
      handle: pagedRuns(pages),
    },
    async (scene) => {
      const notices = await eventually(async () => {
        const found = await scene.notices();
        return found.length === 1 ? found : undefined;
      });
      await scene.stop();
      assert.equal(notices[0]?.["event"], "blocked");
      assert.ok(pages.includes("page-two"));
    },
  );
});

await test("CLV-090 a check in progress skips timer ticks and shutdown waits for the check", async () => {
  const release = Promise.withResolvers<undefined>();
  const counts = { reads: 0 };
  await withNotifier(
    {
      handle: heldScan(release.promise, counts),
    },
    async (scene) => {
      try {
        await eventually(() => (counts.reads === 1 ? true : undefined));
        await delay(40);
        assert.equal(counts.reads, 1);
        const stopping = scene.stop();
        release.resolve(undefined);
        await stopping;
        assert.deepEqual(await scene.notices(), []);
      } finally {
        release.resolve(undefined);
      }
    },
  );
});

await test("CLV-090 failed scans cannot consume event keys and a later check recovers", async () => {
  const counts = { reads: 0 };
  await withNotifier(
    {
      handle: failingScans(counts),
    },
    async (scene) => {
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      assert.ok(counts.reads > 5);
      assert.deepEqual(
        (await notificationJournal(scene.directory)).entries.map(
          (entry) => entry["key"],
        ),
        ["blocked:run-blocked"],
      );
    },
  );
});

await test("CLV-090 a failed questions read retains cached outcomes for the next check", async () => {
  const counts = { statuses: 0, questions: 0 };
  await withNotifier(
    {
      handle: unavailableQuestions(counts),
    },
    async (scene) => {
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      assert.equal(counts.statuses, 1);
      assert.ok(counts.questions >= 2);
      assert.equal((await scene.notices())[0]?.["event"], "blocked");
    },
  );
});

await test("CLV-090 a failed record write sends nothing and retries after the record becomes writable", async () => {
  const state = { ready: false };
  await withNotifier(
    {
      handle: changingRuns(state),
    },
    async (scene) => {
      const temporary = join(scene.directory, "notify-events.json.tmp");
      await mkdir(temporary);
      state.ready = true;
      await delay(75);
      assert.deepEqual(await scene.notices(), []);
      await rm(temporary, { recursive: true });
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
    },
  );
});
