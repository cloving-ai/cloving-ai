import assert from "node:assert/strict";
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
