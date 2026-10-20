import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { outcomeNotification } from "../src/daemon/notify-message.ts";
import type { Fields } from "../src/protocol.ts";
import type { Handle } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";
import {
  blockedRun,
  notificationJournal,
  notifyReply,
  withNotifier,
  withNotificationEnvironment,
} from "./notify-check-fixture.ts";

const heldCommand = `
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
let text = "";
for await (const chunk of process.stdin) text += chunk;
appendFileSync("attempts", text);
while (!existsSync("release")) await setTimeout(5);
appendFileSync("notifications", text);
`;

await test("CLV-132 ready deliveries drain after one scan without another timer tick", async () => {
  const interval = globalThis.setInterval;
  globalThis.setInterval = globalThis.setTimeout;
  let scans = 0;
  try {
    await withNotifier(
      {
        record: backlog(),
        script: heldCommand.replace(
          'while (!existsSync("release")) await setTimeout(5);',
          "",
        ),
        handle: () => {
          scans += 1;
          return notifyReply({ runs: [], next: null, decisions: [] });
        },
      },
      async (scene) => {
        await eventually(async () =>
          (await scene.notices()).length === 20 ? true : undefined,
        );
        await scene.stop();
        assert.equal(scans, 2);
        const entries = (await notificationJournal(scene.directory)).entries;
        assert.ok(entries.every((entry) => entry["state"] === "sent"));
        assert.ok(entries.every((entry) => entry["attempts"] === 2));
        assert.equal(new Set(entries.map((entry) => entry["key"])).size, 20);
      },
    );
  } finally {
    globalThis.setInterval = interval;
  }
});

function backlog(): string {
  return JSON.stringify({
    version: 1,
    entries: Array.from({ length: 20 }, (_, index) => ({
      ...outcomeNotification({ ...blockedRun, runId: `old-${String(index)}` }),
      state: "failed",
      attempts: 1,
      lastAttemptAt: Date.now() - 60_000,
      lastFailure: "exit code 1",
    })),
  });
}

async function attempts(directory: string): Promise<readonly unknown[]> {
  return (await readFile(join(directory, "attempts"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
}

function questionHistory(state: {
  questions: Fields[];
  scans: number;
}): Handle {
  return (request) => {
    if (request.operation === "questions") {
      state.scans += 1;
      return notifyReply({ decisions: state.questions });
    }
    const run = { ...blockedRun, state: "running" };
    return notifyReply({ runs: [run], run, next: null });
  };
}

await test("CLV-132 discovers and saves a transient question during a held backlog delivery", async () => {
  const state = { questions: [] as Fields[], scans: 0 };
  await withNotifier(
    {
      record: backlog(),
      script: heldCommand,
      handle: questionHistory(state),
    },
    async (scene) => {
      const release = () => writeFile(join(scene.directory, "release"), "");
      try {
        await eventually(async () =>
          (await attempts(scene.directory)).length === 1 ? true : undefined,
        );
        state.questions = [
          { runId: blockedRun.runId, decisionId: "transient", prompt: "Help" },
        ];
        const question = await eventually(async () =>
          (await notificationJournal(scene.directory)).entries.find(
            (entry) => entry["key"] === "decision:transient",
          ),
        );
        assert.equal(question["state"], "pending");
        assert.equal(question["attempts"], 0);
        state.questions = [];
        const before = state.scans;
        await eventually(() => (state.scans >= before + 3 ? true : undefined));
        assert.equal((await attempts(scene.directory)).length, 1);
        await release();
        await eventually(async () =>
          (await scene.notices()).length === 21 ? true : undefined,
        );
        await scene.stop();
        assert.equal(
          (await scene.notices()).filter(
            (notice) => notice["event"] === "decision",
          ).length,
          1,
        );
        assert.ok(
          (await notificationJournal(scene.directory)).entries.every(
            (entry) => entry["state"] === "sent",
          ),
        );
      } finally {
        await release();
      }
    },
  );
});

await test("CLV-132 retries a discovery write after storage recovers during an active delivery", () =>
  withNotificationEnvironment(async (environment) => {
    const state = { questions: [] as Fields[], scans: 0 };
    await withNotifier(
      {
        record: backlog(),
        script: heldCommand,
        handle: questionHistory(state),
      },
      async (scene) => {
        const temporary = join(scene.directory, "notify-events.json.tmp");
        try {
          await eventually(async () =>
            (await attempts(scene.directory)).length === 1 ? true : undefined,
          );
          await mkdir(temporary);
          state.questions = [
            {
              runId: blockedRun.runId,
              decisionId: "transient",
              prompt: "Help",
            },
          ];
          await eventually(() =>
            environment.errors.some((line) => line.includes("EISDIR"))
              ? true
              : undefined,
          );
          state.questions = [];
          await rm(temporary, { recursive: true });
          const question = await eventually(async () =>
            (await notificationJournal(scene.directory)).entries.find(
              (entry) => entry["key"] === "decision:transient",
            ),
          );
          assert.equal(question["state"], "pending");
          assert.equal(question["attempts"], 0);
          assert.equal((await attempts(scene.directory)).length, 1);
        } finally {
          await rm(temporary, { recursive: true, force: true });
          await writeFile(join(scene.directory, "release"), "");
        }
      },
    );
  }));

await test("CLV-132 shutdown during discovery schedules no saved delivery", async () => {
  const entered = Promise.withResolvers<undefined>();
  const scan = Promise.withResolvers<undefined>();
  await withNotifier(
    {
      record: backlog(),
      script: heldCommand,
      handle: async () => {
        entered.resolve(undefined);
        await scan.promise;
        return notifyReply({ runs: [], next: null, decisions: [] });
      },
    },
    async (scene) => {
      try {
        await entered.promise;
        const stopping = scene.stop();
        await writeFile(join(scene.directory, "release"), "");
        scan.resolve(undefined);
        await stopping;
        assert.deepEqual(await attempts(scene.directory), []);
        assert.ok(
          (await notificationJournal(scene.directory)).entries.every(
            (entry) => entry["attempts"] === 1 && entry["state"] === "failed",
          ),
        );
      } finally {
        scan.resolve(undefined);
        await writeFile(join(scene.directory, "release"), "");
      }
    },
  );
});

await test("CLV-132 shutdown waits for the active attempt and leaves the backlog for restart", async () => {
  await withNotifier(
    {
      record: backlog(),
      script: heldCommand,
      handle: () => notifyReply({ runs: [], next: null, decisions: [] }),
    },
    async (scene) => {
      try {
        await eventually(async () =>
          (await attempts(scene.directory)).length === 1 ? true : undefined,
        );
        const stopping = scene.stop();
        await writeFile(join(scene.directory, "release"), "");
        await stopping;
        assert.equal((await attempts(scene.directory)).length, 1);
        const entries = (await notificationJournal(scene.directory)).entries;
        assert.equal(
          entries.filter((entry) => entry["state"] === "sent").length,
          1,
        );
        assert.equal(
          entries.filter((entry) => entry["attempts"] === 1).length,
          19,
        );
        await scene.restart();
        await eventually(async () =>
          (await scene.notices()).length === 20 ? true : undefined,
        );
        await scene.stop();
        assert.equal((await attempts(scene.directory)).length, 20);
      } finally {
        await writeFile(join(scene.directory, "release"), "");
      }
    },
  );
});

await test("CLV-132 concurrent shutdown calls share the final delivery write", async () => {
  await withNotifier(
    {
      record: backlog(),
      script: heldCommand,
      handle: () => notifyReply({ runs: [], next: null, decisions: [] }),
    },
    async (scene) => {
      try {
        await eventually(async () =>
          (await attempts(scene.directory)).length === 1 ? true : undefined,
        );
        const stopping = [scene.stop(), scene.stop()];
        await writeFile(join(scene.directory, "release"), "");
        assert.deepEqual(
          (await Promise.allSettled(stopping)).map((result) => result.status),
          ["fulfilled", "fulfilled"],
        );
        assert.equal((await attempts(scene.directory)).length, 1);
        assert.equal(
          (await notificationJournal(scene.directory)).entries[0]?.["state"],
          "sent",
        );
      } finally {
        await writeFile(join(scene.directory, "release"), "");
      }
    },
  );
});
