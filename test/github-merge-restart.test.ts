import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, journalKey, resultOf, until } from "./claude-worker-fixture.ts";
import {
  committed,
  githubIntent,
  opened,
  treeOf,
  withGithub,
} from "./github-worker-fixture.ts";
import {
  advancedBase,
  leftMerge,
  mergeCalls,
  pausedMerge,
} from "./github-merge-fixture.ts";

await test("CLV-081 a restart replays a saved merge repair without running the check again", () =>
  withGithub(async (scene) => {
    const checked = join(scene.directory, "checks");
    const check = [
      process.execPath,
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(checked)}, "check\\n"); process.stderr.write("The assertion failed.\\n"); process.exitCode = 1`,
    ];
    const worker = scene.worker({ check });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    await worker.close();
    assert.equal(report.outcome, "completed");
    assert.deepEqual(resultOf(report.result), {
      reason: "check-failed",
      output: "The assertion failed.\n",
    });
    const recorded = resultOf(
      readFileSync(
        join(scene.journal, journalKey(report.operationId), "result.json"),
        "utf8",
      ),
    );
    assert.equal(recorded["result"], report.result);
    scene.reports.length = 0;
    const restarted = scene.unscanned({ check });
    await restarted.scan();
    await until(() =>
      scene.reports.some((item) => item.operationId === report.operationId),
    );
    const replayed = scene.reports.find(
      (item) => item.operationId === report.operationId,
    );
    assert.deepEqual(replayed, report);
    assert.equal(readFileSync(checked, "utf8"), "check\n");
    assert.deepEqual(mergeCalls(scene), []);
  }));

for (const state of ["open", "merged"]) {
  await test(`CLV-078 resumes a checked and pushed head when the pull request is ${state}`, () =>
    withGithub(async (scene) => {
      const first = scene.worker({
        gh: pausedMerge(scene),
        check: [process.execPath, "-e", ""],
      });
      const commit = await opened(scene, first);
      advancedBase(scene);
      const worker = scene.worker({
        gh: pausedMerge(scene),
        check: [process.execPath, "-e", ""],
        document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
      });
      await worker.deliver(
        githubIntent({ method: "merge", operationId: "merge-paused" }),
        new AbortController().signal,
      );
      await until(() => existsSync(join(scene.directory, "paused")));
      await worker.close();
      const updated = git(scene.origin, ["rev-parse", "cloving/ticket-one"]);
      assert.notEqual(updated, commit);
      const folder = join(scene.journal, journalKey("merge-paused"));
      assert.deepEqual(
        JSON.parse(readFileSync(join(folder, "updated-head.json"), "utf8")),
        { commit, updated },
      );
      if (state === "merged")
        scene.gh([
          "api",
          "-X",
          "PUT",
          "repos/{owner}/{repo}/pulls/1/merge",
          "-f",
          `sha=${updated}`,
        ]);
      const restarted = scene.unscanned({
        check: [process.execPath, "-e", "process.exit(1)"],
      });
      await restarted.scan();
      await until(() =>
        scene.reports.some((report) => report.operationId === "merge-paused"),
      );
      const report = scene.reports.find(
        (report) => report.operationId === "merge-paused",
      );
      assert.equal(report?.outcome, "completed", report?.reason ?? "");
      assert.deepEqual(resultOf(report.result), {
        number: 1,
        commit,
        updated,
        merged: "f".repeat(40),
      });
      assert.equal(mergeCalls(scene).length, 1);
      assert.ok(mergeCalls(scene)[0]?.includes(`sha=${updated}`));
    }));
}

await test("CLV-078 pushes the recorded head after a restart before its push, even if local HEAD changed", () =>
  withGithub(async (scene) => {
    const initial = scene.worker();
    const commit = await opened(scene, initial);
    await initial.close();
    advancedBase(scene);
    git(treeOf(scene), ["fetch", "--quiet", "origin"]);
    git(treeOf(scene), ["merge", "--no-ff", "--no-edit", "origin/main"]);
    const updated = git(treeOf(scene), ["rev-parse", "HEAD"]);
    const folder = leftMerge(scene, commit);
    writeFileSync(
      join(folder, "updated-head.json"),
      JSON.stringify({ commit, updated }),
    );
    committed(treeOf(scene), { name: "unchecked.ts", text: "3;\n" });
    const restarted = scene.unscanned({
      check: [process.execPath, "-e", "process.exit(1)"],
    });
    await restarted.scan();
    await until(() =>
      scene.reports.some((report) => report.operationId === "merge-left"),
    );
    const report = scene.reports.find(
      (report) => report.operationId === "merge-left",
    );
    assert.equal(report?.outcome, "completed", report?.reason ?? "");
    assert.equal(scene.state().prs[0]?.["mergedHead"], updated);
    assert.equal(mergeCalls(scene).length, 1);
  }));

await test("CLV-078 refreshes and checks a recorded head when the base advances before restart", () =>
  withGithub(async (scene) => {
    const initial = scene.worker();
    const commit = await opened(scene, initial);
    await initial.close();
    advancedBase(scene);
    git(treeOf(scene), ["fetch", "--quiet", "origin"]);
    git(treeOf(scene), ["merge", "--no-ff", "--no-edit", "origin/main"]);
    const recorded = git(treeOf(scene), ["rev-parse", "HEAD"]);
    const folder = leftMerge(scene, commit);
    writeFileSync(
      join(folder, "updated-head.json"),
      JSON.stringify({ commit, updated: recorded }),
    );
    git(treeOf(scene), ["push", "--quiet", "origin", "HEAD"]);
    const base = committed(scene.repository, {
      name: "newer.ts",
      text: "3;\n",
    });
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const checked = join(scene.directory, "checked");
    const restarted = scene.unscanned({
      check: [
        process.execPath,
        "-e",
        `
        const fs = require("node:fs");
        const { execFileSync } = require("node:child_process");
        if (fs.readFileSync("src/newer.ts", "utf8") !== "3;\\n") process.exit(1);
        fs.writeFileSync(${JSON.stringify(checked)}, execFileSync("git", ["rev-parse", "HEAD"]));
      `,
      ],
    });
    await restarted.scan();
    await until(() =>
      scene.reports.some((report) => report.operationId === "merge-left"),
    );
    const report = scene.reports.find(
      (report) => report.operationId === "merge-left",
    );
    assert.equal(report?.outcome, "completed", report?.reason ?? "");
    const updated = String(resultOf(report.result)["updated"]);
    assert.notEqual(updated, recorded, "Resume must include the newer base");
    assert.equal(readFileSync(checked, "utf8").trim(), updated);
    assert.equal(
      git(scene.repository, ["rev-parse", `${updated}^1`]),
      recorded,
    );
    assert.equal(git(scene.repository, ["rev-parse", `${updated}^2`]), base);
    assert.deepEqual(
      JSON.parse(readFileSync(join(folder, "updated-head.json"), "utf8")),
      { commit, updated },
    );
    assert.equal(scene.state().prs[0]?.["mergedHead"], updated);
    assert.equal(mergeCalls(scene).length, 1);
    assert.ok(mergeCalls(scene)[0]?.includes(`sha=${updated}`));
  }));

await test("CLV-078 resets an unrecorded update to the reviewed commit and requires a new check", () =>
  withGithub(async (scene) => {
    const initial = scene.worker();
    const commit = await opened(scene, initial);
    await initial.close();
    advancedBase(scene);
    git(treeOf(scene), ["fetch", "--quiet", "origin"]);
    git(treeOf(scene), ["merge", "--no-ff", "--no-edit", "origin/main"]);
    committed(treeOf(scene), { name: "unchecked.ts", text: "3;\n" });
    leftMerge(scene, commit);
    const restarted = scene.unscanned();
    await restarted.scan();
    await until(() =>
      scene.reports.some((report) => report.operationId === "merge-left"),
    );
    assert.equal(
      scene.reports.find((report) => report.operationId === "merge-left")
        ?.reason,
      "check-required",
    );
    assert.equal(existsSync(join(treeOf(scene), "src/unchecked.ts")), false);
    assert.equal(git(treeOf(scene), ["rev-parse", "HEAD^1"]), commit);
    assert.deepEqual(mergeCalls(scene), []);
  }));

for (const state of ["staged", "unstaged"]) {
  await test(`CLV-078 preserves ${state} tracked edits when an interrupted update moved HEAD`, () =>
    withGithub(async (scene) => {
      const initial = scene.worker();
      const commit = await opened(scene, initial);
      await initial.close();
      advancedBase(scene);
      git(treeOf(scene), ["fetch", "--quiet", "origin"]);
      git(treeOf(scene), ["merge", "--no-ff", "--no-edit", "origin/main"]);
      const updated = git(treeOf(scene), ["rev-parse", "HEAD"]);
      writeFileSync(join(treeOf(scene), "src/one.ts"), "unsaved\n");
      if (state === "staged") git(treeOf(scene), ["add", "src/one.ts"]);
      const status = git(treeOf(scene), ["status", "--porcelain"]);
      const folder = leftMerge(scene, commit);
      const restarted = scene.unscanned();
      await restarted.scan();
      await until(() =>
        scene.reports.some((report) => report.operationId === "merge-left"),
      );
      assert.equal(
        scene.reports.find((report) => report.operationId === "merge-left")
          ?.reason,
        "uncommitted-change",
      );
      assert.equal(git(treeOf(scene), ["rev-parse", "HEAD"]), updated);
      assert.equal(git(treeOf(scene), ["status", "--porcelain"]), status);
      assert.equal(
        readFileSync(join(treeOf(scene), "src/one.ts"), "utf8"),
        "unsaved\n",
      );
      assert.equal(existsSync(join(folder, "updated-head.json")), false);
      assert.deepEqual(mergeCalls(scene), []);
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
    }));
}

await test("CLV-078 aborts an unfinished merge even when HEAD is still reviewed and repeats the update", () =>
  withGithub(async (scene) => {
    const initial = scene.worker();
    const commit = await opened(scene, initial);
    await initial.close();
    advancedBase(scene);
    git(treeOf(scene), ["fetch", "--quiet", "origin"]);
    git(treeOf(scene), ["merge", "--no-ff", "--no-commit", "origin/main"]);
    assert.equal(git(treeOf(scene), ["rev-parse", "HEAD"]), commit);
    const folder = leftMerge(scene, commit);
    const restarted = scene.unscanned({ check: [process.execPath, "-e", ""] });
    await restarted.scan();
    await until(() => existsSync(join(folder, "result.json")));
    const report = scene.reports.find(
      (report) => report.operationId === "merge-left",
    );
    assert.equal(report?.outcome, "completed", report?.reason ?? "");
    const updated = String(resultOf(report.result)["updated"]);
    assert.notEqual(updated, commit);
    assert.equal(mergeCalls(scene).length, 1);
    assert.equal(existsSync(treeOf(scene)), false);
  }));
