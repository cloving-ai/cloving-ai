import assert from "node:assert/strict";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { outcomeNotification } from "../src/daemon/notify-message.ts";
import { recordedNotifications } from "../src/daemon/notify-journal.ts";
import type { Fields } from "../src/protocol.ts";
import type { Handle } from "../src/service/transport.ts";
import { eventually, withHarness } from "./service-fixture.ts";
import {
  blockedRun,
  notificationJournal,
  notifyReply,
  withNotifier,
  withNotificationEnvironment,
} from "./notify-check-fixture.ts";

const now = 1_800_000_000_000;
const week = 7 * 24 * 60 * 60_000;

function historicalNotifications(decisions: readonly Fields[]): Handle {
  const runs = [blockedRun, { ...blockedRun, runId: "old-failed" }].map(
    (run) => ({
      ...run,
      latestAt: new Date(now - week - 1).toISOString(),
    }),
  );
  return (request) =>
    notifyReply(
      request.operation === "questions"
        ? { decisions }
        : {
            runs,
            next: null,
            run: runs.find((run) => run.runId === request.parameters["runId"]),
          },
    );
}

await test("CLV-132 rejects malformed journal entries and duplicate keys", async () => {
  const entry = {
    ...outcomeNotification(blockedRun),
    state: "sent",
    attempts: 1,
    lastAttemptAt: now,
    lastFailure: null,
  };
  await withHarness(async (harness) => {
    const file = join(harness.stateDirectory, "notify-events.json");
    for (const invalid of [
      null,
      { ...entry, key: 1 },
      { ...entry, state: "unknown" },
      { ...entry, attempts: -1 },
      { ...entry, attempts: 6 },
      { ...entry, attempts: 1.5 },
      { ...entry, lastAttemptAt: "bad" },
      { ...entry, lastAttemptAt: -1 },
      { ...entry, lastFailure: 4 },
      { ...entry, message: null, state: "pending" },
      { ...entry, message: "bad" },
      { ...entry, message: { event: "unknown" } },
      { ...entry, message: { event: "blocked" } },
    ]) {
      await writeFile(file, JSON.stringify({ version: 1, entries: [invalid] }));
      await assert.rejects(
        recordedNotifications(file),
        /invalid-notify-record/,
      );
    }
    for (const invalid of [
      { version: 1, entries: [entry, entry] },
      { version: 1, entries: [], retiredKeys: [1] },
      { version: 2, entries: [] },
      { version: 1, entries: null },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(
        recordedNotifications(file),
        /invalid-notify-record/,
      );
    }
  });
});

await test("CLV-132 unseen old events and overdue retryable failures remain deliverable", () =>
  withNotificationEnvironment(async () => {
    const retry = outcomeNotification({ ...blockedRun, runId: "retry-run" });
    await withNotifier(
      {
        record: JSON.stringify({
          version: 1,
          entries: [
            {
              ...retry,
              state: "failed",
              attempts: 1,
              lastAttemptAt: now - week - 1,
              lastFailure: "exit code 1",
            },
          ],
        }),
        handle: historicalNotifications([
          {
            runId: blockedRun.runId,
            decisionId: "old-question",
            openedAt: new Date(now - week - 1).toISOString(),
            allowed: [],
            prompt: "Still waiting",
          },
        ]),
      },
      async (scene) => {
        await eventually(async () =>
          (await scene.notices()).length === 4 ? true : undefined,
        );
        await scene.stop();
        assert.deepEqual(
          (await scene.notices()).map((notice) => notice["event"]),
          ["blocked", "blocked", "blocked", "decision"],
        );
        assert.equal(
          (await notificationJournal(scene.directory)).entries.find(
            (entry) => entry["key"] === retry?.key,
          )?.["attempts"],
          2,
        );
      },
    );
  }));

await test("CLV-132 prunes old sent and failed entries without resending old history after restart", () =>
  withNotificationEnvironment(async () => {
    const event = outcomeNotification(blockedRun);
    const old = {
      ...event,
      state: "sent",
      attempts: 1,
      lastAttemptAt: now - week - 1,
      lastFailure: null,
    };
    const history = historicalNotifications([]);
    let scans = 0;
    await withNotifier(
      {
        record: JSON.stringify({
          version: 1,
          entries: [
            old,
            {
              ...old,
              key: "blocked:old-failed",
              state: "failed",
              attempts: 5,
              lastFailure: "exit code 1",
            },
            { ...old, key: "blocked:boundary", lastAttemptAt: now - week },
          ],
        }),
        handle: (request, connection) => {
          scans += 1;
          return history(request, connection);
        },
      },
      async (scene) => {
        await eventually(() => (scans >= 6 ? true : undefined));
        await scene.stop();
        assert.deepEqual(
          (await notificationJournal(scene.directory)).entries.map(
            (entry) => entry["key"],
          ),
          ["blocked:boundary"],
        );
        await scene.restart();
        const before = scans;
        await eventually(() => (scans >= before + 6 ? true : undefined));
        await scene.stop();
        assert.deepEqual(await scene.notices(), []);
        assert.deepEqual(
          (await notificationJournal(scene.directory)).entries.map(
            (entry) => entry["key"],
          ),
          ["blocked:boundary"],
        );
      },
    );
  }));

await test("CLV-132 retries a failed sent-state write without running a successful command again", () =>
  withNotificationEnvironment(async (environment) => {
    const logs = environment.errors;
    await withNotifier(
      {
        handle: () =>
          notifyReply({
            runs: [blockedRun],
            run: blockedRun,
            next: null,
            decisions: [],
          }),
        script: `
import { appendFileSync, mkdirSync } from "node:fs";
let text = "";
for await (const chunk of process.stdin) text += chunk;
appendFileSync("notifications", text);
mkdirSync("notify-events.json.tmp");
`,
      },
      async (scene) => {
        await eventually(() =>
          logs.some((line) => line.includes("EISDIR")) ? true : undefined,
        );
        assert.equal(
          (await notificationJournal(scene.directory)).entries[0]?.["state"],
          "pending",
        );
        await rm(join(scene.directory, "notify-events.json.tmp"), {
          recursive: true,
        });
        await eventually(async () =>
          (await notificationJournal(scene.directory)).entries[0]?.["state"] ===
          "sent"
            ? true
            : undefined,
        );
        await scene.stop();
        assert.equal((await scene.notices()).length, 1);
      },
    );
  }));

await test("CLV-132 replaces an existing temporary journal with private permissions", async () => {
  const state = { ready: false };
  await withNotifier(
    {
      handle: () =>
        notifyReply({
          runs: state.ready ? [blockedRun] : [],
          run: blockedRun,
          next: null,
          decisions: [],
        }),
    },
    async (scene) => {
      const file = join(scene.directory, "notify-events.json");
      await writeFile(`${file}.tmp`, "stale");
      await chmod(`${file}.tmp`, 0o644);
      state.ready = true;
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(await stat(`${file}.tmp`).catch(() => undefined), undefined);
    },
  );
});

await test("CLV-132 persists a fixed start failure without command secrets", async () => {
  await withNotifier(
    {
      command: ["missing-notify-secret-canary", "secret-argument-canary"],
      handle: () =>
        notifyReply({
          runs: [blockedRun],
          run: blockedRun,
          next: null,
          decisions: [],
        }),
    },
    async (scene) => {
      const entry = await eventually(async () => {
        const found = (await notificationJournal(scene.directory)).entries[0];
        return found?.["state"] === "failed" ? found : undefined;
      });
      await scene.stop();
      assert.equal(entry["lastFailure"], "spawn ENOENT");
      const journal = await readFile(
        join(scene.directory, "notify-events.json"),
        "utf8",
      );
      assert.ok(!journal.includes("canary"));
      assert.deepEqual(
        entry["message"],
        outcomeNotification(blockedRun)?.message,
      );
    },
  );
});
