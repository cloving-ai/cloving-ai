import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { matchesCall, mergeCalls } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

const connectionFailure =
  "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n";

for (const call of ["api GET pull", "api GET check-runs"]) {
  for (const detail of [
    "connection reset",
    "gh: unavailable (HTTP 502)",
    connectionFailure,
  ]) {
    await test(`CLV-194 retries ${detail.replace(/\n.*/s, "")} from ${call}`, () =>
      withGithub(async (scene) => {
        const worker = scene.worker();
        const commit = await opened(scene, worker);
        const before = scene.state().calls.length;
        scene.plan({ scores: [], failures: [{ call, detail }] });
        const report = await scene.perform(worker, {
          method: "merge",
          payload: { number: 1, commit },
        });
        assert.equal(report.outcome, "completed", report.reason ?? "");
        const attempts = scene
          .state()
          .calls.slice(before)
          .filter((parts) => matchesCall(parts, call));
        assert.equal(attempts.length, 2);
        assert.equal(mergeCalls(scene).length, 1);
      }));
  }
}

await test("CLV-194 does not retry a check-run client error", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      failures: [
        { call: "api GET check-runs", detail: "gh: forbidden (HTTP 403)" },
      ],
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "github-call-failed");
    assert.equal(
      scene
        .state()
        .calls.filter((parts) =>
          parts.some((part) => part.includes("/check-runs")),
        ).length,
      1,
    );
    assert.equal(mergeCalls(scene).length, 0);
  }));

for (const call of ["api PUT merge", "api GET pull", "api GET check-runs"]) {
  for (const detail of ["", "gh: authentication required"]) {
    await test(`CLV-194 does not retry a local ${call} failure with ${JSON.stringify(detail)}`, () =>
      withGithub(async (scene) => {
        const worker = scene.worker();
        const commit = await opened(scene, worker);
        const before = scene.state().calls.length;
        scene.plan({ scores: [], failures: [{ call, detail }] });
        const report = await scene.perform(worker, {
          method: "merge",
          payload: { number: 1, commit },
        });
        assert.equal(report.outcome, "failed");
        assert.equal(report.reason, "github-call-failed");
        const attempts = scene
          .state()
          .calls.slice(before)
          .filter((parts) => matchesCall(parts, call));
        assert.equal(attempts.length, 1);
        assert.equal(scene.state().prs[0]?.["state"], "OPEN");
        assert.equal(existsSync(treeOf(scene)), true);
      }));
  }
}
