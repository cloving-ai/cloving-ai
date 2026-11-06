import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf } from "./claude-worker-fixture.ts";
import {
  opened,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";
import {
  advancedBase,
  mergeCalls,
  unreachableMerge,
} from "./github-merge-fixture.ts";

async function failedAttempt(
  scene: GithubScene,
  attempt: { readonly check?: "beforeMerge" | null },
): Promise<{ readonly commit: string; readonly updated: string }> {
  const worker = scene.worker({
    gh: unreachableMerge(scene),
    check: [process.execPath, "-e", ""],
  });
  const commit = await opened(scene, worker);
  advancedBase(scene);
  const report = await scene.perform(worker, {
    method: "merge",
    payload: { number: 1, commit, ...attempt },
  });
  await worker.close();
  assert.equal(report.reason, "github-network-failed");
  const updated = git(scene.origin, ["rev-parse", "cloving/ticket-one"]);
  assert.notEqual(updated, commit);
  return { commit, updated };
}

await test("CLV-300 a merge retry in a new operation merges the head that the earlier attempt pushed", () =>
  withGithub(async (scene) => {
    const { commit, updated } = await failedAttempt(scene, {});
    const retry = scene.worker({
      check: [process.execPath, "-e", "process.exit(1)"],
    });
    const report = await scene.perform(retry, {
      method: "merge",
      payload: { number: 1, commit },
    });
    await retry.close();
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      commit,
      updated,
      merged: "f".repeat(40),
    });
    assert.equal(mergeCalls(scene).length, 1);
    assert.ok(mergeCalls(scene)[0]?.includes(`sha=${updated}`));
  }));

await test("CLV-300 a merge retry that asks for the check runs it on a head that an unchecked attempt pushed", () =>
  withGithub(async (scene) => {
    const { commit } = await failedAttempt(scene, { check: null });
    const marker = join(scene.directory, "checked");
    const retry = scene.worker({
      check: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(1)`,
      ],
    });
    const report = await scene.perform(retry, {
      method: "merge",
      payload: { number: 1, commit, check: "beforeMerge" },
    });
    await retry.close();
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["reason"], "check-failed");
    assert.ok(existsSync(marker));
    assert.deepEqual(mergeCalls(scene), []);
  }));
