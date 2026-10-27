import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { journalKey, resultOf } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import {
  fastTiming,
  opened,
  treeOf,
  withGithub,
} from "./github-worker-fixture.ts";

function matchesCall(parts: readonly string[], call: string): boolean {
  return (
    (call === "api PUT merge" && parts.includes("PUT")) ||
    (call === "api GET pull" &&
      parts.length === 2 &&
      parts[1]?.endsWith("/pulls/1") === true) ||
    (call === "api GET check-runs" &&
      parts.some((part) => part.includes("/check-runs")))
  );
}

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

await test("CLV-194 grows the wait between transient merge attempts", () =>
  withGithub(async (scene) => {
    const pollMilliseconds = 120;
    const worker = scene.worker({
      timing: { ...fastTiming, pollMilliseconds },
    });
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      failures: ["connection reset", "i/o timeout"].map((detail) => ({
        call: "api PUT merge",
        detail,
      })),
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const state = scene.state();
    const times = state.callTimes.filter((_, index) =>
      state.calls[index]?.includes("PUT"),
    );
    assert.equal(times.length, 3);
    assert.ok(Number(times[1]) - Number(times[0]) >= pollMilliseconds);
    assert.ok(Number(times[2]) - Number(times[1]) >= pollMilliseconds * 2);
  }));

for (const call of ["api PUT merge", "api GET pull", "api GET check-runs"]) {
  for (const detail of [
    "TLS handshake timeout",
    "gh: unavailable (HTTP 502)",
  ]) {
    await test(`CLV-194 retains persistent ${detail} from ${call} after three attempts`, () =>
      withGithub(async (scene) => {
        const worker = scene.worker();
        const commit = await opened(scene, worker);
        const before = scene.state().calls.length;
        scene.plan({
          scores: [],
          failures: Array.from({ length: 3 }, () => ({ call, detail })),
        });
        const report = await scene.perform(worker, {
          method: "merge",
          payload: { number: 1, commit },
        });
        assert.equal(report.outcome, "failed");
        assert.equal(report.reason, "github-network-failed");
        const record = resultOf(
          readFileSync(
            join(scene.journal, journalKey(report.operationId), "result.json"),
            "utf8",
          ),
        );
        assert.equal(record["reason"], "github-network-failed");
        assert.equal(record["detail"], detail);
        const attempts = scene
          .state()
          .calls.slice(before)
          .filter((parts) => matchesCall(parts, call));
        assert.equal(attempts.length, 3);
        assert.equal(scene.state().prs[0]?.["state"], "OPEN");
        assert.equal(existsSync(treeOf(scene)), true);
      }));
  }
}

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
