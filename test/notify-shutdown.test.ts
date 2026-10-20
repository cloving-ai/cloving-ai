import assert from "node:assert/strict";
import filesystem, { mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { outcomeNotification } from "../src/daemon/notify-message.ts";
import { eventually } from "./service-fixture.ts";
import {
  blockedRun,
  notificationJournal,
  notifyReply,
  withNotifier,
  withNotificationEnvironment,
} from "./notify-check-fixture.ts";

function pausedSave(directory: string) {
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const rename = filesystem.rename;
  let paused = false;
  filesystem.rename = async (from, to) => {
    if (to === join(directory, "notify-events.json") && !paused) {
      paused = true;
      reached.resolve(undefined);
      await release.promise;
    }
    await rename(from, to);
  };
  syncBuiltinESMExports();
  return {
    reached: reached.promise,
    release: () => {
      release.resolve(undefined);
    },
    restore: () => {
      filesystem.rename = rename;
      syncBuiltinESMExports();
    },
  };
}

await test("CLV-132 shutdown during preparation preserves the unsent fifth attempt for restart", async () => {
  const previous = {
    ...outcomeNotification(blockedRun),
    state: "failed",
    attempts: 4,
    lastAttemptAt: Date.now() - 3_600_000,
    lastFailure: "exit code 1",
  };
  await withNotifier(
    {
      record: JSON.stringify({ version: 1, entries: [previous] }),
      handle: () => notifyReply({ runs: [], next: null, decisions: [] }),
    },
    async (scene) => {
      const save = pausedSave(scene.directory);
      try {
        await save.reached;
        const stopping = scene.stop();
        save.release();
        await stopping;
        assert.deepEqual(await scene.notices(), []);
        assert.deepEqual((await notificationJournal(scene.directory)).entries, [
          previous,
        ]);
        save.restore();
        await scene.restart();
        await eventually(async () =>
          (await scene.notices()).length === 1 ? true : undefined,
        );
        await scene.stop();
        const entry = (await notificationJournal(scene.directory)).entries[0];
        assert.equal(entry?.["state"], "sent");
        assert.equal(entry["attempts"], 5);
      } finally {
        save.release();
        save.restore();
      }
    },
  );
});

await test("CLV-132 shutdown reports an unwritable delivery result and still completes", () =>
  withNotificationEnvironment(async (environment) => {
    await withNotifier(
      {
        handle: (request) =>
          notifyReply(
            request.operation === "questions"
              ? { decisions: [] }
              : { runs: [blockedRun], run: blockedRun, next: null },
          ),
        script: `
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
let text = "";
for await (const chunk of process.stdin) text += chunk;
appendFileSync("notifications", text);
while (!existsSync("release")) await setTimeout(5);
`,
      },
      async (scene) => {
        const temporary = join(scene.directory, "notify-events.json.tmp");
        try {
          await eventually(async () =>
            (await scene.notices()).length === 1 ? true : undefined,
          );
          await mkdir(temporary);
          const stopping = scene.stop();
          await writeFile(join(scene.directory, "release"), "");
          await assert.doesNotReject(stopping);
          assert.ok(environment.errors.some((line) => line.includes("EISDIR")));
        } finally {
          await rm(temporary, { recursive: true, force: true });
          await writeFile(join(scene.directory, "release"), "");
        }
        await scene.stop();
        assert.equal(
          (await notificationJournal(scene.directory)).entries[0]?.["state"],
          "sent",
        );
      },
    );
  }));
