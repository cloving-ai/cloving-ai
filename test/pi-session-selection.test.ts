import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  intent,
  journalKey,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { fakePi } from "./pi-fixture.ts";

await test("CLV-365 Pi refuses command session selectors before a process or prompt starts", async () => {
  for (const selection of [
    ["--continue"],
    ["-c"],
    ["--resume"],
    ["-r"],
    ["--session", "foreign"],
    ["--session=foreign"],
    ["--session-id", "foreign"],
    ["--session-dir", "foreign"],
    ["--fork", "foreign"],
    ["--no-session"],
    ["--", "extra prompt"],
  ])
    await withScene(async (scene) => {
      const command = [fakePi(scene), "--mode", "json", ...selection];
      await scene
        .worker("unused", { harness: { name: "pi", command } })
        .deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "failed");
      assert.equal(scene.reports[0].reason, "pi-session-command-unsupported");
      assert.equal(
        existsSync(join(scene.directory, "pi-prompts.jsonl")),
        false,
      );
    });
});

await test("CLV-365 a crash before the Pi start record refuses the orphan session without adopting it", () =>
  withScene(async (scene) => {
    const folder = join(scene.journal, journalKey("operation-1"), "pi-session");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, "session.jsonl");
    writeFileSync(path, "orphan session", { mode: 0o600 });
    const worker = scene.worker("unused", {
      harness: { name: "pi", path: fakePi(scene) },
    });
    await assert.doesNotReject(() =>
      worker.deliver(intent(), new AbortController().signal),
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "pi-session-state-unowned");
    assert.equal(readFileSync(path, "utf8"), "orphan session");
    assert.equal(existsSync(join(scene.directory, "pi-prompts.jsonl")), false);
  }));
