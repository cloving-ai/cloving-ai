import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "./claude-worker-fixture.ts";
import {
  committed,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const branch = "cloving/task-0123456789ab";

function pushedBranch(scene: GithubScene, name: string = branch): string {
  git(scene.repository, ["switch", "--quiet", "-c", name]);
  const head = committed(scene.repository, { name: "stuck.ts", text: "1;\n" });
  git(scene.repository, ["push", "--quiet", "origin", name]);
  git(scene.repository, ["switch", "--quiet", "main"]);
  git(scene.repository, ["branch", "--quiet", "-D", name]);
  return head;
}

function openPull(
  scene: GithubScene,
  pull: { readonly head: string; readonly state?: string },
): void {
  scene.plan({
    scores: [],
    prs: [
      { number: 7, head: pull.head, base: "main", state: pull.state ?? "OPEN" },
    ],
  });
}

await test("CLV-305 prepare with a pull request number makes a work tree on its branch", () =>
  withGithub(async (scene) => {
    const head = pushedBranch(scene);
    openPull(scene, { head: branch });
    const report = await scene.perform(scene.worker(), {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    const tree = join(scene.worktrees, "task-0123456789ab");
    assert.deepEqual(JSON.parse(String(report.result)), {
      target: "task-0123456789ab",
      branch,
      worktree: tree,
      base: "main",
      startCommit: head,
      head,
    });
    assert.equal(git(tree, ["rev-parse", "HEAD"]), head);
    assert.equal(git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  }));

await test("CLV-305 prepare refuses a pull request that a person opened or that is not open", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    pushedBranch(scene, "feature/search");
    openPull(scene, { head: "feature/search" });
    const person = await scene.perform(worker, {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    pushedBranch(scene);
    openPull(scene, { head: branch, state: "MERGED" });
    const merged = await scene.perform(worker, {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    assert.deepEqual(
      [person, merged].map((report) => [report.outcome, report.reason]),
      [
        ["failed", "pull-request-not-cloving"],
        ["failed", "pull-request-not-open"],
      ],
    );
    assert.equal(
      git(scene.repository, ["worktree", "list"]).split("\n").length,
      1,
    );
  }));

await test("CLV-305 prepare brings a kept work tree up to the pull request head", () =>
  withGithub(async (scene) => {
    const first = pushedBranch(scene);
    openPull(scene, { head: branch });
    const worker = scene.worker();
    await scene.perform(worker, {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    const other = join(scene.directory, "other");
    git(scene.directory, [
      "clone",
      "--quiet",
      "--branch",
      branch,
      scene.origin,
      other,
    ]);
    for (const [name, value] of [
      ["user.name", "Cloving Test"],
      ["user.email", "test@cloving.invalid"],
      ["commit.gpgsign", "false"],
    ] as const)
      git(other, ["config", name, value]);
    const later = committed(other, { name: "later.ts", text: "2;\n" });
    git(other, ["push", "--quiet", "origin", branch]);
    const report = await scene.perform(worker, {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    const result: unknown = JSON.parse(String(report.result));
    assert.deepEqual(
      [
        Reflect.get(Object(result), "startCommit"),
        Reflect.get(Object(result), "head"),
      ],
      [first, later],
    );
    assert.equal(
      git(join(scene.worktrees, "task-0123456789ab"), ["rev-parse", "HEAD"]),
      later,
    );
  }));

await test("CLV-305 prepare keeps an unfinished merge on the pull request head for the next turn", () =>
  withGithub(async (scene) => {
    const head = pushedBranch(scene);
    openPull(scene, { head: branch });
    const worker = scene.worker();
    await scene.perform(worker, {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    committed(scene.repository, { name: "stuck.ts", text: "2;\n" });
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const tree = join(scene.worktrees, "task-0123456789ab");
    git(tree, ["fetch", "--quiet", "origin"]);
    const merge = spawnSync("git", [
      "-C",
      tree,
      "merge",
      "--quiet",
      "origin/main",
    ]);
    const report = await scene.perform(worker, {
      method: "prepare",
      payload: { pullRequest: 7 },
    });
    assert.deepEqual(
      [merge.status, report.outcome, report.reason],
      [1, "completed", undefined],
    );
    assert.equal(
      Reflect.get(Object(JSON.parse(String(report.result))), "head"),
      head,
    );
    assert.equal(
      git(tree, ["diff", "--name-only", "--diff-filter=U"]),
      "src/stuck.ts",
    );
  }));

await test("CLV-305 prepare gives a pull request to one active run at a time", () =>
  withGithub(async (scene) => {
    pushedBranch(scene);
    openPull(scene, { head: branch });
    const statuses = new Map([
      ["run-1", "running"],
      ["run-2", "running"],
    ]);
    const worker = scene.worker({
      runStatus: (runId) => Promise.resolve(statuses.get(runId)),
    });
    const prepared = async (runId: string) => {
      const report = await scene.perform(worker, {
        method: "prepare",
        payload: { pullRequest: 7 },
        runId,
      });
      return report.reason ?? report.outcome;
    };
    const first = await prepared("run-1");
    const second = await prepared("run-2");
    const again = await prepared("run-1");
    statuses.set("run-1", "failed");
    const later = await prepared("run-2");
    const old = await prepared("run-1");
    assert.deepEqual(
      [first, second, again, later, old],
      [
        "completed",
        "pull-request-claimed",
        "completed",
        "completed",
        "pull-request-claimed",
      ],
    );
    mkdirSync(join(scene.directory, "tree-claims", "task-0123456789ab"), {
      recursive: true,
    });
    assert.equal(await prepared("run-2"), "pull-request-claimed");
  }));

await test("CLV-305 prepare refuses an invalid number, a nested branch, a diverged branch and a blocked tree", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const prepared = async (payload: unknown) => {
      const report = await scene.perform(worker, {
        method: "prepare",
        payload,
      });
      return report.reason;
    };
    const invalid = await prepared({ pullRequest: "7" });
    pushedBranch(scene, "cloving/feature/search");
    openPull(scene, { head: "cloving/feature/search" });
    const nested = await prepared({ pullRequest: 7 });
    pushedBranch(scene);
    openPull(scene, { head: branch });
    await prepared({ pullRequest: 7 });
    const tree = join(scene.worktrees, "task-0123456789ab");
    committed(tree, { name: "local.ts", text: "3;\n" });
    git(scene.repository, [
      "switch",
      "--quiet",
      "-c",
      "other",
      `origin/${branch}`,
    ]);
    committed(scene.repository, { name: "remote.ts", text: "4;\n" });
    git(scene.repository, [
      "push",
      "--quiet",
      "--force",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ]);
    git(scene.repository, ["switch", "--quiet", "main"]);
    const diverged = await prepared({ pullRequest: 7 });
    pushedBranch(scene, "cloving/task-ba9876543210");
    openPull(scene, { head: "cloving/task-ba9876543210" });
    mkdirSync(scene.worktrees, { recursive: true });
    writeFileSync(join(scene.worktrees, "task-ba9876543210"), "");
    const blocked = await prepared({ pullRequest: 7 });
    assert.deepEqual(
      [invalid, nested, diverged, blocked],
      [
        "invalid-payload",
        "pull-request-not-cloving",
        "pull-request-diverged",
        "work-tree-not-available",
      ],
    );
  }));
