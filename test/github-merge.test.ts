import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseCommand } from "../src/authority/commands.ts";
import type { ObservationReport } from "../src/service/worker-port.ts";
import { git, resultOf } from "./claude-worker-fixture.ts";
import {
  advancedBase,
  mergeCalls,
  movingMerge,
} from "./github-merge-fixture.ts";
import { committed, opened, withGithub } from "./github-worker-fixture.ts";

await test("CLV-256 records the refused merge before refreshing main", () =>
  withGithub(async (scene) => {
    const observations: ObservationReport[] = [];
    const settings = {
      gh: movingMerge(scene, { limit: 1 }),
      check: [process.execPath, "-e", ""],
      observe: (report: ObservationReport) => {
        assert.equal(scene.state().prs[0]?.["state"], "OPEN");
        observations.push(report);
        return Promise.resolve({ kind: "accepted" });
      },
    };
    const worker = scene.worker(settings);
    const commit = await opened(scene, worker);
    scene.plan({ scores: [], mergeRefusals: 1, mergeStatus: 405 });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.equal(observation?.runId, report.runId);
    assert.equal(observation.operationId, report.operationId);
    assert.equal(observation.reason, "github-merge-refused");
    assert.notEqual(
      parseCommand({ kind: "report-observation", ...observation }),
      null,
    );
    assert.equal(observation.attempt, 1);
    assert.equal(observation.limit, 3);
    assert.match(
      observation.evidence ?? "",
      new RegExp(`HTTP-405.*${commit}.*main`),
    );
  }));

await test("CLV-081 completes a failed check with its output and no push or merge", () =>
  withGithub(async (scene) => {
    const trace = join(scene.directory, "git-trace");
    const worker = scene.worker({
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
        GIT_TRACE: trace,
      },
      check: [
        process.execPath,
        "-e",
        'process.stdout.write("Failed test: merged tree\\n"); process.stderr.write("Expected 2, got 1\\n"); process.exitCode = 1',
      ],
    });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    writeFileSync(trace, "");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      reason: "check-failed",
      output: "Failed test: merged tree\nExpected 2, got 1\n",
    });
    assert.doesNotMatch(readFileSync(trace, "utf8"), /built-in: git push/);
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
  }));

await test("CLV-081 keeps only the last 6000 characters of failed check output", () =>
  withGithub(async (scene) => {
    const stdout = "discard this prefix\n" + "a".repeat(6_000);
    const stderr = "\nThe failing assertion.\n";
    const worker = scene.worker({
      check: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1`,
      ],
    });
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      reason: "check-failed",
      output: (stdout + stderr).slice(-6_000),
    });
  }));

await test("CLV-078 refreshes the branch, checks the updated tree and merges its pushed head", () =>
  withGithub(async (scene) => {
    const checked = join(scene.directory, "checked");
    const worker = scene.worker({
      check: [
        process.execPath,
        "-e",
        `
        const fs = require("node:fs");
        const { execFileSync } = require("node:child_process");
        if (fs.readFileSync("src/base.ts", "utf8") !== "2;\\n") process.exit(1);
        fs.writeFileSync(${JSON.stringify(checked)}, execFileSync("git", ["rev-parse", "HEAD"]));
      `,
      ],
    });
    const commit = await opened(scene, worker);
    const base = committed(scene.repository, { name: "base.ts", text: "2;\n" });
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const updated = readFileSync(checked, "utf8").trim();
    assert.notEqual(updated, commit);
    assert.equal(git(scene.repository, ["rev-parse", `${updated}^1`]), commit);
    assert.equal(git(scene.repository, ["rev-parse", `${updated}^2`]), base);
    assert.equal(scene.state().prs[0]?.["mergedHead"], updated);
    assert.ok(
      scene.state().calls.some((call) => call.includes(`sha=${updated}`)),
    );
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      commit,
      updated,
      merged: "f".repeat(40),
    });
  }));
