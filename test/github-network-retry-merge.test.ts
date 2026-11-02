import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { resultOf } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

await test("CLV-194 retries a merge after one TLS handshake timeout", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      failures: [{ call: "api PUT merge", detail: "TLS handshake timeout" }],
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(mergeCalls(scene).length, 2);
    assert.equal(scene.state().prs[0]?.["state"], "MERGED");
    const sequence = scene.state().calls;
    const first = sequence.findIndex((call) => call.includes("PUT"));
    assert.deepEqual(sequence[first + 1], [
      "api",
      "repos/{owner}/{repo}/pulls/1",
    ]);
  }));

for (const status of [500, 502, 503, 504]) {
  await test(`CLV-194 retries HTTP ${String(status)} on an updated merge`, () =>
    withGithub(async (scene) => {
      const worker = scene.worker({ check: [process.execPath, "-e", ""] });
      const commit = await opened(scene, worker);
      advancedBase(scene);
      scene.plan({
        scores: [],
        failures: [
          {
            call: "api PUT merge",
            detail: `gh: unavailable (HTTP ${String(status)})`,
          },
        ],
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, "completed", report.reason ?? "");
      const result = resultOf(report.result);
      assert.notEqual(result["updated"], commit);
      const calls = mergeCalls(scene);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.ok(calls[1]?.includes(`sha=${String(result["updated"])}`));
    }));
}

for (const head of ["reviewed", "updated"]) {
  for (const attempt of [1, 3]) {
    await test(`CLV-194 reconciles a lost merge reply on attempt ${String(attempt)} for the ${head} head`, () =>
      withGithub(async (scene) => {
        const worker = scene.worker({ check: [process.execPath, "-e", ""] });
        const commit = await opened(scene, worker);
        if (head === "updated") advancedBase(scene);
        scene.plan({
          scores: [],
          failures: [
            ...Array.from({ length: attempt - 1 }, () => ({
              call: "api PUT merge",
              detail: "TLS handshake timeout",
            })),
            { call: "api PUT merge", detail: "EOF", after: true },
          ],
        });
        const report = await scene.perform(worker, {
          method: "merge",
          payload: { number: 1, commit },
        });
        assert.equal(report.outcome, "completed", report.reason ?? "");
        const result = resultOf(report.result);
        assert.equal(result["commit"], commit);
        assert.equal(result["updated"], scene.state().prs[0]?.["mergedHead"]);
        assert.equal(result["merged"], "f".repeat(40));
        assert.equal(mergeCalls(scene).length, attempt);
        assert.equal(existsSync(treeOf(scene)), false);
      }));
  }
}
