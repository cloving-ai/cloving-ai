import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { outcomeNotification } from "../src/daemon/notify-message.ts";
import { eventually } from "./service-fixture.ts";
import {
  blockedRun,
  notifyReply,
  notificationJournal,
  withNotifier,
  withNotificationEnvironment,
} from "./notify-check-fixture.ts";

function deliveryScript(failures: number): string {
  return `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const attempts = existsSync("attempts") ? readFileSync("attempts", "utf8").trim().split("\\n").length : 0;
appendFileSync("attempts", text);
if (attempts < ${String(failures)}) process.exit(1);
appendFileSync("notifications", text);
`;
}

async function failedAttempt(directory: string, attempts: number) {
  return eventually(async () => {
    const journal = await notificationJournal(directory);
    const entry = journal.entries[0];
    return entry?.["state"] === "failed" && entry["attempts"] === attempts
      ? entry
      : undefined;
  });
}

function blockedHistory(request: { readonly operation: string }) {
  return notifyReply(
    request.operation === "questions"
      ? { decisions: [] }
      : { runs: [blockedRun], run: blockedRun, next: null },
  );
}

function savedEntry(overrides: Fields = {}): string {
  return JSON.stringify({
    version: 1,
    entries: [
      {
        ...outcomeNotification(blockedRun),
        state: "pending",
        attempts: 0,
        lastAttemptAt: null,
        lastFailure: null,
        ...overrides,
      },
    ],
  });
}

await test("CLV-132 retries the identical failed notification once and records sent", () =>
  withNotificationEnvironment(async (environment) => {
    await withNotifier(
      { handle: blockedHistory, script: deliveryScript(1) },
      async (scene) => {
        const attempts = join(scene.directory, "attempts");
        await eventually(async () =>
          (await readFile(attempts, "utf8").catch(() => "")).includes("blocked")
            ? true
            : undefined,
        );
        environment.now += 60_000;
        await eventually(async () =>
          (await scene.notices()).length === 1 ? true : undefined,
        );
        await scene.stop();
        const sent = (await scene.notices())[0];
        assert.deepEqual(sent, outcomeNotification(blockedRun)?.message);
        const tried = (await readFile(attempts, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        assert.deepEqual(tried, [sent, sent]);
        assert.deepEqual(
          JSON.parse(
            await readFile(join(scene.directory, "notify-events.json"), "utf8"),
          ),
          {
            version: 1,
            entries: [
              {
                key: "blocked:run-blocked",
                message: sent,
                state: "sent",
                attempts: 2,
                lastAttemptAt: 1_800_000_060_000,
                lastFailure: "exit code 1",
              },
            ],
          },
        );
      },
    );
  }));

await test("CLV-132 restart retries a pending entry even when its event is no longer listed", async () => {
  let scans = 0;
  await withNotifier(
    {
      record: savedEntry(),
      script: deliveryScript(0),
      handle: () => {
        scans += 1;
        return notifyReply({ runs: [], next: null, decisions: [] });
      },
    },
    async (scene) => {
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      assert.equal(
        (await notificationJournal(scene.directory)).entries[0]?.["state"],
        "sent",
      );
      await scene.restart();
      const before = scans;
      await eventually(() => (scans >= before + 6 ? true : undefined));
      await scene.stop();
      assert.equal((await scene.notices()).length, 1);
      assert.equal(
        (await notificationJournal(scene.directory)).entries[0]?.["attempts"],
        1,
      );
    },
  );
});

await test("CLV-132 migrates legacy keys as sent without delivering them again", () =>
  withNotificationEnvironment(async () => {
    let scans = 0;
    await withNotifier(
      {
        record: '["blocked:run-blocked"]',
        script: deliveryScript(0),
        handle: (request) => {
          scans += 1;
          return blockedHistory(request);
        },
      },
      async (scene) => {
        await eventually(() => (scans >= 6 ? true : undefined));
        await scene.stop();
        assert.deepEqual(await notificationJournal(scene.directory), {
          version: 1,
          entries: [
            {
              key: "blocked:run-blocked",
              message: null,
              state: "sent",
              attempts: 0,
              lastAttemptAt: 1_800_000_000_000,
              lastFailure: null,
            },
          ],
        });
        await scene.restart();
        const before = scans;
        await eventually(() => (scans >= before + 6 ? true : undefined));
        await scene.stop();
        assert.deepEqual(await scene.notices(), []);
      },
    );
  }));

await test("CLV-132 exhausts five attempts at fixed backoffs and logs its key once", () =>
  withNotificationEnvironment(async (environment) => {
    const logs = environment.errors;
    let scans = 0;
    await withNotifier(
      {
        handle: (request) => {
          scans += 1;
          return blockedHistory(request);
        },
        script: deliveryScript(5),
      },
      async (scene) => {
        let attempts = 1;
        await failedAttempt(scene.directory, attempts);
        for (const minutes of [1, 5, 15, 60]) {
          environment.now += minutes * 60_000 - 1;
          const before = scans;
          await eventually(() => (scans >= before + 6 ? true : undefined));
          assert.equal(
            (await notificationJournal(scene.directory)).entries[0]?.[
              "attempts"
            ],
            attempts,
          );
          environment.now += 1;
          attempts += 1;
          await failedAttempt(scene.directory, attempts);
        }
        environment.now += 24 * 60 * 60_000;
        const before = scans;
        await eventually(() => (scans >= before + 6 ? true : undefined));
        await scene.stop();
        const entry = (await notificationJournal(scene.directory)).entries[0];
        assert.equal(entry?.["attempts"], 5);
        assert.equal(entry["state"], "failed");
        assert.equal(entry["lastFailure"], "exit code 1");
        assert.equal(entry["lastAttemptAt"], 1_800_004_860_000);
        assert.deepEqual(await scene.notices(), []);
        assert.deepEqual(logs, [
          "Notify delivery failed: blocked:run-blocked\n",
        ]);
      },
    );
  }));

await test("CLV-132 restart respects a failed entry's remaining delay and attempt count", () =>
  withNotificationEnvironment(async (environment) => {
    let scans = 0;
    await withNotifier(
      {
        record: savedEntry({
          state: "failed",
          attempts: 2,
          lastAttemptAt: Date.now(),
          lastFailure: "exit code 1",
        }),
        script: deliveryScript(0),
        handle: () => {
          scans += 1;
          return notifyReply({ runs: [], next: null, decisions: [] });
        },
      },
      async (scene) => {
        await eventually(() => (scans >= 6 ? true : undefined));
        environment.now += 299_999;
        await scene.restart();
        const before = scans;
        await eventually(() => (scans >= before + 6 ? true : undefined));
        assert.deepEqual(await scene.notices(), []);
        environment.now += 1;
        await eventually(async () =>
          (await scene.notices()).length === 1 ? true : undefined,
        );
        await scene.stop();
        const entry = (await notificationJournal(scene.directory)).entries[0];
        assert.equal(entry?.["attempts"], 3);
        assert.equal(entry["state"], "sent");
        assert.equal(entry["lastFailure"], "exit code 1");
      },
    );
  }));

await test("CLV-132 interrupted fifth attempts become terminal failures once on restart", () =>
  withNotificationEnvironment(async (environment) => {
    const logs = environment.errors;
    let scans = 0;
    await withNotifier(
      {
        record: savedEntry({ attempts: 5, lastAttemptAt: Date.now() }),
        script: deliveryScript(0),
        handle: () => {
          scans += 1;
          return notifyReply({ runs: [], next: null, decisions: [] });
        },
      },
      async (scene) => {
        await eventually(() => (scans >= 6 ? true : undefined));
        await scene.stop();
        const entry = (await notificationJournal(scene.directory)).entries[0];
        assert.equal(entry?.["state"], "failed");
        assert.equal(entry["attempts"], 5);
        assert.equal(entry["lastFailure"], "attempt interrupted");
        await scene.restart();
        const before = scans;
        await eventually(() => (scans >= before + 6 ? true : undefined));
        await scene.stop();
        assert.deepEqual(await scene.notices(), []);
        assert.deepEqual(logs, [
          "Notify delivery failed: blocked:run-blocked\n",
        ]);
      },
    );
  }));
