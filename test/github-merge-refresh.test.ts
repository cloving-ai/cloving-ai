import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf } from "./claude-worker-fixture.ts";
import {
  advancedBase,
  mergeCalls,
  movingCheck,
} from "./github-merge-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";

await test("CLV-078 requires a check before pushing an updated branch", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    advancedBase(scene);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "check-required");
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
  }));

await test("CLV-078 stops after two repeats when the base moves during every check", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ check: movingCheck(scene, 3) });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "base-moved");
    assert.equal(readFileSync(join(scene.directory, "checks"), "utf8"), "3");
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
  }));

await test("CLV-078 repeats the update and check when the base moves once", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ check: movingCheck(scene, 1) });
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(readFileSync(join(scene.directory, "checks"), "utf8"), "2");
    const updated = String(resultOf(report.result)["updated"]);
    assert.equal(
      git(scene.repository, ["merge-base", "origin/main", updated]),
      git(scene.origin, ["rev-parse", "main"]),
    );
  }));
