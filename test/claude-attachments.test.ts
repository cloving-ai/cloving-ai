import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { command, turn } from "./claude-profiles-fixture.ts";
import { field, withScene } from "./claude-worker-fixture.ts";

await test("CLV-268 each worker turn gets the attachment folder of its run, outside the work tree", () =>
  withScene(async (scene) => {
    const observed = await turn(scene, {
      method: "run-turn",
      settings: { command: command(scene) },
    });
    const folder = field(observed["env"], "CLOVING_ATTACHMENTS_DIRECTORY");
    assert.equal(
      folder,
      join(dirname(scene.worktrees), "attachments", "ticket-one"),
    );
    assert.equal(existsSync(folder), true);
    assert.equal(statSync(folder).isDirectory(), true);
    assert.equal(folder.startsWith(scene.worktrees), false);
  }));
