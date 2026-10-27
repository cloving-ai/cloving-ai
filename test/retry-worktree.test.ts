import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { retryEvidence, turnHead } from "../src/daemon/retry-worktree.ts";
import { git, until, withScene } from "./claude-worker-fixture.ts";
import {
  origin,
  withBlockedGit,
  withGitDeadline,
  stopGit,
} from "./retry-git-fixture.ts";

await test("CLV-229 an absent origin branch makes every local commit not pushed", () =>
  withScene(async (scene) => {
    origin(scene);
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    const start = await turnHead(tree);
    git(scene.repository, ["commit", "--allow-empty", "-m", "Local change"]);
    const commit = git(scene.repository, ["rev-parse", "HEAD"]);
    const evidence = await retryEvidence(tree, start);
    assert.ok(evidence.includes(`${commit} not pushed`));
    assert.doesNotMatch(evidence, /unknown/);
  }));

await test("CLV-229 fresh origin evidence distinguishes remote and local commits", () =>
  withScene(async (scene) => {
    origin(scene);
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    const start = await turnHead(tree);
    git(scene.repository, ["commit", "--allow-empty", "-m", "Remote change"]);
    const pushed = git(scene.repository, ["rev-parse", "HEAD"]);
    git(scene.repository, ["push", "origin", "HEAD"]);
    git(scene.repository, [
      "update-ref",
      "refs/remotes/origin/main",
      String(start),
    ]);
    git(scene.repository, ["commit", "--allow-empty", "-m", "Local change"]);
    const local = git(scene.repository, ["rev-parse", "HEAD"]);
    const evidence = await retryEvidence(tree, start);
    assert.ok(evidence.includes(`${pushed} pushed`));
    assert.ok(evidence.includes(`${local} not pushed`));
  }));

await test("CLV-229 a silent origin times out at thirty seconds and keeps unknown commit evidence", () =>
  withScene(async (scene) => {
    origin(scene);
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    const start = await turnHead(tree);
    git(scene.repository, ["commit", "--allow-empty", "-m", "Change"]);
    const commit = git(scene.repository, ["rev-parse", "HEAD"]);
    git(scene.repository, ["push", "origin", "HEAD"]);
    await withBlockedGit("fetch", async (blocked) => {
      await withGitDeadline(async (clock) => {
        let finished = false;
        const pending = retryEvidence(tree, start).then((value) => {
          finished = true;
          return value;
        });
        await until(() => blocked() !== undefined);
        assert.equal(clock.duration(), 30_000);
        await nextTurn();
        assert.equal(finished, false);
        clock.expire();
        assert.ok((await pending).includes(`${commit} unknown`));
      });
    });
  }));

await test("CLV-229 failed git reads give explicit unknown evidence, never an empty list", () =>
  withScene(async (scene) => {
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    assert.match(
      await retryEvidence(tree, null),
      /unknown.*could not be determined/,
    );
    assert.match(
      await retryEvidence(tree, "invalid-head"),
      /unknown.*could not be listed/,
    );
    const stopped = new AbortController();
    stopped.abort();
    assert.equal(await turnHead({ ...tree, signal: stopped.signal }), null);
  }));

await test("CLV-229 an unavailable git executable gives unknown evidence", () =>
  withScene(async (scene) => {
    const previous = process.env["PATH"];
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    const start = git(scene.repository, ["rev-parse", "HEAD"]);
    process.env["PATH"] = scene.directory;
    try {
      assert.equal(await turnHead(tree), null);
      assert.match(
        await retryEvidence(tree, start),
        /unknown.*could not be listed/,
      );
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  }));

await test("CLV-229 detached branches retain local commits with unknown push state", () =>
  withScene(async (scene) => {
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    const start = await turnHead(tree);
    git(scene.repository, ["checkout", "--quiet", "--detach"]);
    git(scene.repository, ["commit", "--allow-empty", "-m", "Detached change"]);
    const commit = git(scene.repository, ["rev-parse", "HEAD"]);
    assert.ok((await retryEvidence(tree, start)).includes(`${commit} unknown`));
  }));

await test("CLV-229 an empty local range distinguishes missing origin from an absent remote branch", () =>
  withScene(async (scene) => {
    const tree = {
      directory: scene.repository,
      signal: new AbortController().signal,
    };
    const start = await turnHead(tree);
    assert.match(await retryEvidence(tree, start), /unknown.*no local commits/);
    origin(scene);
    assert.equal(
      await retryEvidence(tree, start),
      "No commits since the start of this turn.",
    );
  }));

await test("CLV-229 git fixture cleanup never signals a missing or invalid process id", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  assert.ok(descriptor);
  const calls: number[] = [];
  Object.defineProperty(process, "kill", {
    value: (pid: number) => {
      calls.push(pid);
      return true;
    },
  });
  try {
    for (const pid of [undefined, 0, -1, NaN]) stopGit(pid);
    assert.deepEqual(calls, []);
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
});
