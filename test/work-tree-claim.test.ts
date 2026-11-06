import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { treePlace, workTree } from "../src/daemon/work-tree.ts";

async function withRepository(
  body: (place: {
    readonly repository: string;
    readonly worktrees: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-claim-")));
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  await mkdir(repository);
  await mkdir(worktrees);
  const git = (parts: readonly string[]) =>
    execFileSync("git", ["-C", repository, ...parts], { stdio: "ignore" });
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.name", "Cloving Test"]);
  git(["config", "user.email", "test@cloving.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["commit", "--quiet", "--allow-empty", "-m", "Start"]);
  try {
    await body({ repository, worktrees });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("CLV-310 a work tree setup waits while the sweep holds the claim of its target", () =>
  withRepository(async ({ repository, worktrees }) => {
    const target = "ticket/one";
    const claim = `${treePlace({ worktrees, target }).path}.removing`;
    await mkdir(claim);
    const state = { done: false };
    const setup = workTree({
      repository,
      worktrees,
      target,
      signal: new AbortController().signal,
    }).then((tree) => {
      state.done = true;
      return tree;
    });
    await delay(300);
    assert.equal(state.done, false);
    await rm(claim, { recursive: true });
    const tree = await setup;
    assert.equal(existsSync(join(tree.path, ".git")), true);
  }));

await test("CLV-310 a work tree setup refuses a claim that the sweep does not release in time", () =>
  withRepository(async ({ repository, worktrees }) => {
    const target = "ticket/two";
    await mkdir(`${treePlace({ worktrees, target }).path}.removing`);
    await assert.rejects(
      workTree({
        repository,
        worktrees,
        target,
        signal: new AbortController().signal,
        claimMilliseconds: 300,
      }),
      { message: "work-tree-removing" },
    );
  }));
