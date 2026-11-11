import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  git,
  intent,
  interruptedScene,
  journalKey,
  priorProcess,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { withLockOwner } from "./worktree-process-fixture.ts";

const signal = new AbortController().signal;
const folderName = journalKey("operation-1");

for (const scenario of ["missing-session", "changed-harness"] as const)
  await test(`CLV-272 a live earlier worker stops before a ${scenario} restart reports the interruption`, () =>
    withScene(async (scene) => {
      const directory = await interruptedScene(scene);
      const prior = await priorProcess(scene, { directory });
      const folder = join(scene.journal, folderName);
      const started = record(scene, "operation-1/started.json");
      const attempt = record(scene, "operation-1/attempt-1.json");
      assert.ok(typeof started === "object" && started !== null);
      assert.ok(typeof attempt === "object" && attempt !== null);
      writeFileSync(
        join(folder, "started.json"),
        JSON.stringify({ ...started, processId: prior.processId }),
      );
      if (scenario === "missing-session")
        writeFileSync(
          join(folder, "attempt-1.json"),
          JSON.stringify({ ...attempt, sessionId: null }),
        );
      try {
        const reply = await scene
          .worker(
            "hold",
            scenario === "changed-harness" ? { worker: "codex" } : {},
          )
          .reconcile(intent(), signal);
        assert.equal(field(reply, "reason"), "claude-turn-interrupted");
        assert.equal(prior.terminated(), true);
        assert.equal(alive(prior.processId ?? 0), false);
        assert.equal(scene.turns().length, 1);
      } finally {
        await prior.close();
      }
    }));

await test("CLV-272 a leftover tool child stops before a killed turn without a session reports the interruption", () =>
  withScene(async (scene) => {
    await scene.worker("tool-child").deliver(intent(), signal);
    const childFile = join(scene.directory, "turns.log.child");
    await until(() => existsSync(childFile + ".lines"));
    await until(
      () =>
        typeof field(
          record(scene, "operation-1/attempt-1.json"),
          "sessionId",
        ) === "string",
    );
    const childId = Number(readFileSync(childFile, "utf8"));
    const first = scene.turns()[0];
    assert.ok(first);
    const saved = record(scene, "operation-1/attempt-1.json");
    assert.ok(typeof saved === "object" && saved !== null);
    writeFileSync(
      join(scene.journal, folderName, "attempt-1.json"),
      JSON.stringify({ ...saved, sessionId: null }),
    );
    const lockPath = git(first.directory, [
      "rev-parse",
      "--git-path",
      "index.lock",
    ]);
    await withLockOwner(scene, {
      processId: childId,
      directory: join(first.directory, "nested"),
      lockPath,
      run: async () => {
        process.kill(first.processId, "SIGKILL");
        await until(() => scene.reports.length === 1);
        assert.equal(scene.reports[0]?.outcome, "failed");
        assert.equal(scene.reports[0].reason, "claude-turn-interrupted");
        assert.equal(alive(childId), false);
        assert.equal(existsSync(lockPath), false);
        assert.equal(scene.turns().length, 1);
      },
    });
  }));
