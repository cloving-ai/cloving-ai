import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, journalKey, resultOf } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

await test("CLV-078 refuses tracked changes before a check without merging", () =>
  withGithub(async (scene) => {
    const marker = join(scene.directory, "checked");
    const worker = scene.worker({
      check: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "checked")`,
      ],
    });
    const commit = await opened(scene, worker);
    writeFileSync(join(treeOf(scene), "src/one.ts"), "dirty\n");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "uncommitted-change");
    assert.equal(existsSync(marker), false);
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(
      readFileSync(join(treeOf(scene), "src/one.ts"), "utf8"),
      "dirty\n",
    );
  }));

await test("CLV-078 refuses checks that dirty tracked files or change HEAD", async () => {
  for (const script of [
    'require("node:fs").writeFileSync("src/one.ts", "dirty\\n")',
    'require("node:child_process").execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "Check changed HEAD"])',
  ])
    await withGithub(async (scene) => {
      const worker = scene.worker({ check: [process.execPath, "-e", script] });
      const commit = await opened(scene, worker);
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.reason, "uncommitted-change");
      assert.deepEqual(mergeCalls(scene), []);
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
    });
});

await test("CLV-078 keeps an updated head private and unrecorded when privacy or the check fails", async () => {
  for (const [reason, outcome] of [
    ["private-path-in-change", "failed"],
    ["check-failed", "completed"],
  ]) {
    await withGithub(async (scene) => {
      const initial = scene.worker();
      const commit = await opened(scene, initial);
      await initial.close();
      advancedBase(scene);
      const worker = scene.worker({
        privateTexts: reason === "private-path-in-change" ? ["1;"] : [],
        check: [process.execPath, "-e", "process.exit(1)"],
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, outcome);
      assert.equal(report.reason ?? resultOf(report.result)["reason"], reason);
      assert.deepEqual(mergeCalls(scene), []);
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
      assert.equal(
        existsSync(
          join(
            scene.journal,
            journalKey(report.operationId),
            "updated-head.json",
          ),
        ),
        false,
      );
    });
  }
});

await test("CLV-078 the fake merge API refuses a SHA that is not the pull request head", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    assert.throws(
      () =>
        scene.gh([
          "api",
          "-X",
          "PUT",
          "repos/{owner}/{repo}/pulls/1/merge",
          "-f",
          `sha=${"0".repeat(40)}`,
        ]),
      /Head branch was modified/,
    );
    assert.equal(scene.state().prs[0]?.["state"], "OPEN");
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
  }));
