import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { journalKey, resultOf } from "./claude-worker-fixture.ts";
import { matchesCall } from "./github-merge-fixture.ts";
import {
  fastTiming,
  opened,
  treeOf,
  withGithub,
} from "./github-worker-fixture.ts";

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
