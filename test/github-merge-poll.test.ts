import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf, until } from "./claude-worker-fixture.ts";
import { advancedBase, leftMerge, mergeCalls } from "./github-merge-fixture.ts";
import {
  fastTiming,
  githubIntent,
  opened,
  treeOf,
  withGithub,
} from "./github-worker-fixture.ts";

await test("CLV-082 waits for the third pull read after pushing the checked head", () =>
  withGithub(async (scene) => {
    const pollMilliseconds = 150;
    const worker = scene.worker({
      check: [process.execPath, "-e", ""],
      timing: { ...fastTiming, pollMilliseconds },
    });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    scene.plan({ scores: [], headAfterReads: 3 });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const pull = scene.state().prs[0];
    assert.equal(pull?.["headReads"], 3);
    const times = pull["headReadTimes"];
    assert.ok(Array.isArray(times));
    assert.ok(Number(times[1]) - Number(times[0]) >= pollMilliseconds);
    assert.ok(Number(times[2]) - Number(times[1]) >= pollMilliseconds);
    assert.equal(pull["state"], "MERGED");
    assert.equal(pull["mergedHead"], resultOf(report.result)["updated"]);
    assert.equal(mergeCalls(scene).length, 1);
  }));

await test("CLV-082 resumes a pushed head while the pull request still shows the earlier commit", () =>
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
    git(treeOf(scene), ["push", "--quiet", "origin", "HEAD"]);
    scene.plan({ scores: [], headAfterReads: 3 });
    const worker = scene.unscanned({
      check: [process.execPath, "-e", "process.exit(1)"],
    });
    await worker.scan();
    await until(() =>
      scene.reports.some((report) => report.operationId === "merge-left"),
    );
    const report = scene.reports.find(
      (report) => report.operationId === "merge-left",
    );
    assert.equal(report?.outcome, "completed", report?.reason ?? "");
    assert.equal(scene.state().prs[0]?.["headReads"], 3);
    assert.equal(scene.state().prs[0]?.["mergedHead"], updated);
    assert.equal(mergeCalls(scene).length, 1);
  }));

await test("CLV-082 stops a worker during the head poll without a merge call", () =>
  withGithub(async (scene) => {
    const initial = scene.worker();
    const commit = await opened(scene, initial);
    await initial.close();
    advancedBase(scene);
    scene.plan({ scores: [], headAfterReads: 31 });
    const worker = scene.worker({
      check: [process.execPath, "-e", ""],
      timing: { ...fastTiming, pollMilliseconds: 60_000 },
      document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
    });
    const intent = githubIntent({
      method: "merge",
      operationId: "poll-stopped",
    });
    await worker.deliver(intent, new AbortController().signal);
    await until(() => scene.state().prs[0]?.["headReads"] === 1);
    const stopped = await worker.stop(intent, new AbortController().signal);
    assert.equal(stopped.kind, "stopped");
    assert.equal(mergeCalls(scene).length, 0);
  }));

await test("CLV-082 does not retry a merge refusal with another HTTP status", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ check: [process.execPath, "-e", ""] });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    scene.plan({ scores: [], mergeRefusals: 3, mergeStatus: 403 });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "github-call-failed");
    assert.equal(mergeCalls(scene).length, 1);
  }));

await test("CLV-082 stops after 30 stale pull reads without calling merge", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ check: [process.execPath, "-e", ""] });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    scene.plan({ scores: [], headAfterReads: 31 });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "head-not-updated");
    assert.equal(scene.state().prs[0]?.["headReads"], 30);
    assert.equal(mergeCalls(scene).length, 0);
  }));

for (const status of [405, 409]) {
  await test(`CLV-082 waits before retrying HTTP ${String(status)} with the same checked head`, () =>
    withGithub(async (scene) => {
      const pollMilliseconds = 200;
      const worker = scene.worker({
        check: [process.execPath, "-e", ""],
        timing: { ...fastTiming, pollMilliseconds },
      });
      const commit = await opened(scene, worker);
      advancedBase(scene);
      scene.plan({
        scores: [],
        mergeRefusals: 1,
        mergeStatus: status,
        mergePollMilliseconds: pollMilliseconds,
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, "completed", report.reason ?? "");
      const calls = mergeCalls(scene);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      const times = scene.state().prs[0]?.["mergeTimes"];
      assert.ok(Array.isArray(times));
      assert.ok(Number(times[1]) - Number(times[0]) >= pollMilliseconds);
      const sequence = scene.state().calls;
      const first = sequence.findIndex((call) => call.includes("PUT"));
      assert.deepEqual(sequence[first + 1], [
        "api",
        "repos/{owner}/{repo}/pulls/1",
      ]);
    }));
}

await test("CLV-082 stops after three refused merge calls", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ check: [process.execPath, "-e", ""] });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    scene.plan({ scores: [], mergeRefusals: 3 });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "github-call-failed");
    assert.equal(mergeCalls(scene).length, 3);
    assert.equal(scene.state().prs[0]?.["state"], "OPEN");
  }));

await test("CLV-082 leaves an up-to-date branch at one read and one merge without a push", () =>
  withGithub(async (scene) => {
    const trace = join(scene.directory, "git-trace");
    const worker = scene.worker({
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
        GIT_TRACE: trace,
      },
    });
    const commit = await opened(scene, worker);
    writeFileSync(trace, "");
    const before = scene.state().calls.length;
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(mergeCalls(scene).length, 1);
    assert.equal(
      scene
        .state()
        .calls.slice(before)
        .filter((call) => call.length === 2 && call[1]?.endsWith("/pulls/1"))
        .length,
      1,
    );
    assert.doesNotMatch(readFileSync(trace, "utf8"), /built-in: git push/);
  }));
