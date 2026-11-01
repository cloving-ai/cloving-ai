import assert from "node:assert/strict";
import { test } from "node:test";
import { loopReport } from "../src/report.ts";
import { runnerKinds } from "../src/report-ci.ts";
import { fields, items } from "./service-fixture.ts";

const now = Date.parse("2026-10-25T00:00:00Z");
const start = now - 86_400_000;
function report(observedSince: number) {
  const history = Array.from({ length: 7 }, (_, index) => ({
    at: start - (index + 0.5) * 86_400_000,
    value: 1,
    evidence: { jobId: index, runId: index, pullRequest: index, issue: index },
  }));
  const current = {
    at: start + 1,
    value: 2,
    evidence: { jobId: 99, runId: 99, pullRequest: 600, issue: 601 },
  };
  const data = [...history, current];
  const counts = [
    ...history,
    { ...current, value: 1 },
    { ...current, at: start + 2, value: 1 },
  ];
  const runners = {
    localMacos: data,
    localLinux: data,
    hostedMacos: data,
    hostedLinux: data,
  };
  return loopReport({
    since: 24,
    now,
    completions: [],
    effects: [],
    observedSince,
    github: {
      issues: [],
      pulls: counts,
      labels: counts,
      sources: {},
      observedSince,
      ciUsage: {
        jobMinutes: runners,
        jobLimitShare: runners,
        runnerWaitMinutes: runners,
        timeouts: counts,
        reruns: counts,
      },
    },
  });
}

await test("CLV-246 every CI and operator value carries seven-day bands, marks and evidence", () => {
  const result = report(0);
  const ci = fields(result.ci);
  const metrics: unknown[] = [
    result.ci.timeouts,
    result.ci.reruns,
    result.operator.merges,
    result.operator.labelChanges,
  ];
  for (const name of ["jobMinutes", "jobLimitShare", "runnerWaitMinutes"])
    for (const kind of runnerKinds)
      metrics.push(fields(fields(ci[name])[kind]));
  for (const metric of metrics) {
    const value = fields(metric);
    assert.equal(value["value"], 2);
    assert.equal(value["mark"], "outside");
    const baseline = fields(value["baseline"]);
    assert.equal(baseline["median"], 1);
    assert.equal(baseline["history"], "available");
    assert.deepEqual(baseline["band"], { low: 1, high: 1 });
    assert.equal(items(baseline["evidence"]).length, 7);
    assert.ok(items(value["evidence"]).length > 0);
  }
});

await test("CLV-246 short history omits CI and operator marks", () => {
  const result = report(start - 2 * 86_400_000);
  for (const section of [result.ci, result.operator]) {
    const metrics = Object.values(section).flatMap((value) =>
      Object.hasOwn(value, "baseline") ? [value] : Object.values(fields(value)),
    );
    for (const metric of metrics) {
      assert.equal(fields(fields(metric)["baseline"])["history"], "short");
      assert.equal(fields(fields(metric)["baseline"])["band"], null);
      assert.equal(fields(metric)["mark"], undefined);
    }
  }
});
