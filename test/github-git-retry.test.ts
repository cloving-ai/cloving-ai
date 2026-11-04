import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseCommand } from "../src/authority/commands.ts";
import type { WorkerReport } from "../src/daemon/operation-journal.ts";
import type { ObservationReport } from "../src/service/worker-port.ts";
import { git, journalKey, resultOf } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import {
  fakeGit,
  observing,
  publicKeyRefusal,
  shown,
  withGitWaits,
  type Shown,
} from "./github-git-fixture.ts";
import { committed, opened, withGithub } from "./github-worker-fixture.ts";

function commands(
  observations: readonly ObservationReport[],
  report: WorkerReport,
): void {
  for (const observation of observations) {
    assert.equal(observation.runId, report.runId);
    assert.equal(observation.operationId, report.operationId);
    assert.notEqual(
      parseCommand({ kind: "report-observation", ...observation }),
      null,
    );
  }
  const identifiers = observations.map(({ commandId }) => commandId);
  assert.equal(new Set(identifiers).size, identifiers.length);
}

function retries(command: string, count: number): readonly Shown[] {
  return Array.from({ length: count }, (_, index) => ({
    condition: "working",
    reason: "git-network-retry",
    evidence: `git/${command}`,
    attempt: index + 1,
    limit: 3,
  }));
}

await test("CLV-293 completes a merge after one SSH fetch refusal", () =>
  withGithub((scene) =>
    withGitWaits(async (waits) => {
      const remote = fakeGit(scene);
      const seen = observing();
      const worker = scene.worker({
        environment: remote.environment,
        observe: seen.observe,
      });
      const commit = await opened(scene, worker);
      const fetches = remote.invoked("fetch").length;
      const started = Date.now();
      remote.fail({
        command: "fetch",
        mode: "fail",
        outputs: [publicKeyRefusal],
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, "completed", report.reason ?? "");
      assert.equal(scene.state().prs[0]?.["state"], "MERGED");
      assert.deepEqual(waits, [5_000]);
      assert.ok(remote.invoked("fetch").length - fetches >= 3);
      assert.deepEqual(seen.observations.map(shown), [
        ...retries("fetch", 1),
        {
          condition: "working",
          reason: "in-progress",
          evidence: undefined,
          attempt: undefined,
          limit: undefined,
        },
      ]);
      const retryAt = Date.parse(seen.observations[0]?.retryAt ?? "");
      assert.ok(retryAt >= started + 5_000 && retryAt <= Date.now() + 5_000);
      commands(seen.observations, report);
    }),
  ));

await test("CLV-293 ends a merge with git-network-failed after four push failures", () =>
  withGithub((scene) =>
    withGitWaits(async (waits) => {
      const remote = fakeGit(scene);
      const seen = observing();
      const worker = scene.worker({
        environment: remote.environment,
        check: [process.execPath, "-e", ""],
        observe: seen.observe,
      });
      const commit = await opened(scene, worker);
      advancedBase(scene);
      const pushes = remote.invoked("push").length;
      const outputs = [1, 2, 3, 4].map(
        (count) =>
          `fatal: The remote end hung up unexpectedly (${String(count)})\n`,
      );
      remote.fail({ command: "push", mode: "fail", outputs });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, "failed");
      assert.equal(report.reason, "git-network-failed");
      const saved = resultOf(
        readFileSync(
          join(scene.journal, journalKey(report.operationId), "result.json"),
          "utf8",
        ),
      );
      assert.equal(saved["detail"], outputs[3]);
      assert.equal(Object.hasOwn(report, "detail"), false);
      assert.deepEqual(waits, [5_000, 15_000, 45_000]);
      assert.equal(remote.invoked("push").length - pushes, 4);
      assert.deepEqual(mergeCalls(scene), []);
      assert.deepEqual(seen.observations.map(shown), retries("push", 3));
      commands(seen.observations, report);
    }),
  ));

await test("CLV-293 gives a local merge conflict at once with no retry", () =>
  withGithub((scene) =>
    withGitWaits(async (waits) => {
      const remote = fakeGit(scene);
      const worker = scene.worker({ environment: remote.environment });
      const commit = await opened(scene, worker);
      committed(scene.repository, { name: "one.ts", text: "2;\n" });
      git(scene.repository, ["push", "--quiet", "origin", "main"]);
      remote.fail({
        command: "merge",
        mode: "append",
        outputs: ["fatal: The remote end hung up unexpectedly\n"],
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, "completed", report.reason ?? "");
      const repair = resultOf(report.result);
      assert.equal(repair["reason"], "merge-conflict");
      assert.match(String(repair["output"]), /CONFLICT.*src\/one\.ts/);
      assert.deepEqual(waits, []);
      assert.equal(
        remote.invoked("merge").filter((parts) => parts.includes("--no-ff"))
          .length,
        1,
      );
    }),
  ));
