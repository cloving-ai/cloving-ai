import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, journalKey, resultOf } from "./claude-worker-fixture.ts";
import {
  committed,
  opened,
  treeOf,
  withGithub,
} from "./github-worker-fixture.ts";
import {
  advancedBase,
  mergeCalls,
  movingCheck,
} from "./github-merge-fixture.ts";

await test("CLV-078 refreshes the branch, checks the updated tree and merges its pushed head", () =>
  withGithub(async (scene) => {
    const checked = join(scene.directory, "checked");
    const worker = scene.worker({
      check: [
        process.execPath,
        "-e",
        `
        const fs = require("node:fs");
        const { execFileSync } = require("node:child_process");
        if (fs.readFileSync("src/base.ts", "utf8") !== "2;\\n") process.exit(1);
        fs.writeFileSync(${JSON.stringify(checked)}, execFileSync("git", ["rev-parse", "HEAD"]));
      `,
      ],
    });
    const commit = await opened(scene, worker);
    const base = committed(scene.repository, { name: "base.ts", text: "2;\n" });
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const updated = readFileSync(checked, "utf8").trim();
    assert.notEqual(updated, commit);
    assert.equal(git(scene.repository, ["rev-parse", `${updated}^1`]), commit);
    assert.equal(git(scene.repository, ["rev-parse", `${updated}^2`]), base);
    assert.equal(scene.state().prs[0]?.["mergedHead"], updated);
    assert.ok(
      scene.state().calls.some((call) => call.includes(`sha=${updated}`)),
    );
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      commit,
      updated,
      merged: "f".repeat(40),
    });
  }));

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

await test("CLV-078 aborts a conflicting base update without a push or merge call", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    committed(scene.repository, { name: "one.ts", text: "2;\n" });
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.deepEqual(
      [report.outcome, report.reason],
      ["failed", "merge-conflict"],
    );
    assert.equal(git(treeOf(scene), ["rev-parse", "HEAD"]), commit);
    assert.equal(
      existsSync(git(treeOf(scene), ["rev-parse", "--git-path", "MERGE_HEAD"])),
      false,
    );
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
    assert.equal(
      scene.state().calls.some((call) => call.includes("PUT")),
      false,
    );
  }));

await test("CLV-078 keeps an updated head private and unrecorded when privacy or the check fails", async () => {
  for (const reason of ["private-path-in-change", "check-failed"]) {
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
      assert.equal(report.reason, reason);
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

await test("CLV-078 rejects malformed merge replies and retains the branch", async () => {
  for (const reply of [null, [], 42, {}, { sha: null }, { sha: 42 }])
    await withGithub(async (scene) => {
      const worker = scene.worker();
      const commit = await opened(scene, worker);
      scene.plan({ scores: [], replies: { "api PUT merge": reply } });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "github-call-failed"],
      );
      assert.equal(existsSync(treeOf(scene)), true);
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
      assert.equal(mergeCalls(scene).length, 1);
    });
});

await test("CLV-078 rejects malformed pull request heads before merging", async () => {
  for (const head of [undefined, null, [], 42, {}, { sha: null }, { sha: 42 }])
    await withGithub(async (scene) => {
      const worker = scene.worker();
      const commit = await opened(scene, worker);
      scene.plan({
        scores: [],
        replies: { "api GET pull": { merged: false, head } },
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "github-call-failed"],
      );
      assert.deepEqual(mergeCalls(scene), []);
      assert.equal(existsSync(treeOf(scene)), true);
    });
});

await test("CLV-078 rejects malformed known merge commits without cleanup", async () => {
  for (const merged of [undefined, null, 42, false, {}, []])
    await withGithub(async (scene) => {
      const worker = scene.worker();
      const commit = await opened(scene, worker);
      scene.plan({
        scores: [],
        replies: {
          "api GET pull": {
            merged: true,
            head: { sha: commit },
            merge_commit_sha: merged,
          },
        },
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "github-call-failed"],
      );
      assert.deepEqual(mergeCalls(scene), []);
      assert.equal(existsSync(treeOf(scene)), true);
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
    });
});
