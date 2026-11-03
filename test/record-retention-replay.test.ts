import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { recordSweep } from "../src/daemon/record-sweep.ts";
import { githubIntent, treeOf, withGithub } from "./github-worker-fixture.ts";
import { day } from "./record-sweep-fixture.ts";

await test("CLV-270 after a sweep and a restart, an active run replays its completed effect from its kept record", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    writeFileSync(join(treeOf(scene), "draft.md"), "# Draft\n");
    const captured = await scene.perform(worker, {
      method: "capture-draft",
      payload: { draft: "draft.md" },
    });
    const lines: string[] = [];
    await recordSweep({
      directory: scene.directory,
      retention: { days: 30, action: "delete", archiveFolder: null },
      runs: () =>
        Promise.resolve({
          [captured.runId]: { status: "waiting_gate", endedAt: null },
        }),
      now: () => Date.now() + 400 * day,
      log: (line) => lines.push(line),
    }).pass();
    const restarted = scene.worker();
    const replay = await restarted.reconcile(
      githubIntent({
        operationId: captured.operationId,
        method: "capture-draft",
      }),
      new AbortController().signal,
    );
    assert.ok(replay.kind === "completed", JSON.stringify(replay));
    assert.equal(replay.result, captured.result);
    assert.deepEqual(lines, [
      "retention: deleted 0, kept 0, skipped 2 (active runs), unreadable 0\n",
    ]);
  }));
