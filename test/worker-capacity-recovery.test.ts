import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";
import {
  field,
  intent,
  journalKey,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

await test("CLV-127 a daemon killed during its capacity wait fails recovery without relaunching", () =>
  withScene(async (scene) => {
    const settings = {
      repository: scene.repository,
      journal: scene.journal,
      worktrees: scene.worktrees,
      command: [
        process.execPath,
        join(scene.directory, "fake-claude.mjs"),
        "capacity-always",
        join(scene.directory, "turns.log"),
      ],
    };
    const module = new URL("../src/daemon/claude-worker.ts", import.meta.url)
      .href;
    const source = `import { claudeWorker } from ${JSON.stringify(module)};
      const worker = claudeWorker({ ...${JSON.stringify(settings)}, document: async () => "original prompt", report: async () => undefined });
      await worker.deliver(${JSON.stringify(intent())}, new AbortController().signal);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { env: { ...process.env, NODE_V8_COVERAGE: undefined }, stdio: "ignore" },
    );
    const closed = once(child, "close");
    try {
      await until(
        () =>
          field(record(scene, "operation-1/started.json"), "phase") ===
          "waiting",
      );
      assert.equal(
        field(record(scene, "operation-1/started.json"), "processId"),
        null,
      );
      assert.equal(
        typeof field(record(scene, "operation-1/attempt-1.json"), "endedAt"),
        "string",
      );
      child.kill("SIGKILL");
      await closed;
      const restarted = scene.worker("hold");
      const expected = {
        kind: "failed",
        receipt: journalKey("operation-1"),
        worker: "claude",
        reason: "claude-turn-interrupted",
      };
      const signal = new AbortController().signal;
      assert.deepEqual(await restarted.reconcile(intent(), signal), expected);
      assert.deepEqual(await restarted.deliver(intent(), signal), expected);
      assert.equal(scene.turns().length, 1);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  }));
