import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf } from "./claude-worker-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";

await test("CLV-220 a named check that is not configured fails before any merge work", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    advancedBase(scene);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit, check: "beforeMerge" },
    });
    assert.equal(report.reason, "check-not-configured");
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
  }));

await test("CLV-220 a null check merges an updated branch with no local check", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    advancedBase(scene);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit, check: null },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["commit"], commit);
    assert.notEqual(result["updated"], commit);
    assert.equal(mergeCalls(scene).length, 1);
  }));

await test("CLV-220 a named check runs the configured command on the updated branch", () =>
  withGithub(async (scene) => {
    const marker = join(scene.directory, "checked");
    const worker = scene.worker({
      check: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
      ],
    });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit, check: "beforeMerge" },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.ok(existsSync(marker));
    assert.equal(mergeCalls(scene).length, 1);
  }));

await test("CLV-220 an unknown check name is an invalid payload", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit, check: "afterMerge" },
    });
    assert.equal(report.reason, "invalid-payload");
    assert.deepEqual(mergeCalls(scene), []);
  }));
