import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { changes } from "../src/daemon/work-tree.ts";
import {
  git,
  intent,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

await test("CLV-221 a development report identifies the full immutable local commit", () =>
  withScene(async (scene) => {
    const worker = scene.worker("committed");
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const result = resultOf(scene.reports[0]?.result);
    const commit = git(join(scene.worktrees, "ticket-one"), [
      "rev-parse",
      "HEAD",
    ]);
    assert.equal(result["commit"], commit);
    assert.match(commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(result["uncommitted"], []);
  }));

await test("CLV-221 a Git status failure remains unknown instead of reporting a clean snapshot", () =>
  withScene(async (scene) => {
    const startCommit = git(scene.repository, ["rev-parse", "HEAD"]);
    await writeFile(join(scene.repository, ".git/index"), "corrupt");
    const result = await changes({
      path: scene.repository,
      branch: "main",
      startCommit,
    });
    assert.equal(result.commit, startCommit);
    assert.equal(result.uncommitted, null);
  }));
