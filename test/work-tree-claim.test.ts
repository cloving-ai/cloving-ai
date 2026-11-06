import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { treeClaim, workTree } from "../src/daemon/work-tree.ts";

interface Place {
  readonly repository: string;
  readonly worktrees: string;
}

async function withRepository(
  body: (place: Place) => Promise<void>,
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

function setup(
  place: Place,
  request: { readonly target: string; readonly claimMilliseconds?: number },
) {
  return workTree({
    ...place,
    ...request,
    signal: new AbortController().signal,
  });
}

await test("CLV-310 a work tree setup waits while the sweep holds the claim of its target", () =>
  withRepository(async (place) => {
    const claim = treeClaim({
      worktrees: place.worktrees,
      target: "ticket/one",
    });
    await mkdir(claim, { recursive: true });
    const state = { done: false };
    const started = setup(place, { target: "ticket/one" }).then((tree) => {
      state.done = true;
      return tree;
    });
    await delay(300);
    assert.equal(state.done, false);
    await rm(claim, { recursive: true });
    const tree = await started;
    assert.equal(existsSync(join(tree.path, ".git")), true);
  }));

await test("CLV-310 a work tree setup refuses a claim that the sweep does not release in time", () =>
  withRepository(async (place) => {
    const claim = treeClaim({
      worktrees: place.worktrees,
      target: "ticket/two",
    });
    await mkdir(claim, { recursive: true });
    await assert.rejects(
      setup(place, { target: "ticket/two", claimMilliseconds: 300 }),
      {
        message: "work-tree-removing",
      },
    );
  }));

await test("CLV-310 a work tree with a claim-like name does not block another target", () =>
  withRepository(async (place) => {
    await mkdir(join(place.worktrees, "alpha.removing"));
    const tree = await setup(place, {
      target: "alpha",
      claimMilliseconds: 300,
    });
    assert.equal(existsSync(join(tree.path, ".git")), true);
  }));
