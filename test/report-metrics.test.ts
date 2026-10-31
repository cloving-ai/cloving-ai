import assert from "node:assert/strict";
import { test } from "node:test";
import { loopReport } from "../src/report.ts";
import { fields, items } from "./service-fixture.ts";
import { effectEvents } from "./report-fixture.ts";

const now = Date.parse("2026-10-25T00:00:00Z");
const day = 86_400_000;
const names = [
  "fixRounds.medianPerMergedPullRequest",
  "leadTime.medianHours",
  "phases.workerTurn.medianMinutes",
  "phases.codeReview.medianMinutes",
  "phases.merge.medianMinutes",
  "cost.medianCompletedTicketUsd",
];

function historyScene() {
  let sequence = 0;
  const rows = Array.from({ length: 8 }, (_, index) => {
    const runId = `history-${String(index)}`;
    const at = now - (index + 0.5) * day;
    const value = index === 0 ? 9 : 1;
    const number = index + 10;
    const methods = [
      "run-turn",
      "open-pr",
      ...Array.from({ length: value }, () => "run-turn"),
      "wait-review",
      "merge",
    ];
    const effects = methods.flatMap((method) => {
      sequence += 2;
      return effectEvents(runId, {
        method,
        sequence,
        at,
        minutes: value,
        result: { merged: true, number },
      });
    });
    return {
      effects,
      completion: {
        runId,
        sequence: sequence + 1,
        at: at + 20 * 60_000,
        outcome: "completed" as const,
      },
      cost: {
        runId,
        ticketId: String(number),
        turns: [{ operationId: `${runId}-turn`, costUsd: value }],
      },
      issue: { at: at + 30 * 60_000, value: 1, evidence: { issue: number } },
      lead: { at: at + 30 * 60_000, value, evidence: { issue: number } },
    };
  });
  return {
    now,
    since: 24,
    observedSince: now - 9 * day,
    effects: rows.flatMap((row) => row.effects),
    completions: rows.map((row) => row.completion),
    costs: rows.map((row) => row.cost),
    github: {
      observedSince: now - 9 * day,
      issues: rows.map((row) => row.issue),
      leadTimes: rows.map((row) => row.lead),
      pulls: [],
      sources: {},
    },
  };
}

await test("CLV-243 each new median uses seven daily medians, a band, an outside mark and separate evidence", () => {
  const report = loopReport(historyScene());
  for (const name of names) {
    const metric = fields(fields(report["metrics"])[name]);
    assert.equal(metric["value"], 9, name);
    assert.equal(metric["mark"], "outside", name);
    const baseline = fields(metric["baseline"]);
    assert.equal(baseline["days"], 7, name);
    assert.equal(baseline["median"], 1, name);
    assert.deepEqual(baseline["band"], { low: 1, high: 1 }, name);
    assert.ok(items(metric["evidence"]).length > 0, name);
    assert.ok(items(baseline["evidence"]).length >= 7, name);
  }
  const ticket = fields(items(report["completedTicketCosts"])[0]);
  assert.equal(ticket["mark"], "outside");
  assert.equal(fields(ticket["baseline"])["median"], 1);
});

await test("CLV-243 each new median has short history without a band or mark when history is incomplete", () => {
  const scene = historyScene();
  const report = loopReport({
    ...scene,
    observedSince: now - day,
    github: { ...scene.github, observedSince: now - day },
  });
  for (const name of names) {
    const metric = fields(fields(report["metrics"])[name]);
    assert.equal(metric["value"], 9, name);
    assert.equal(metric["mark"], undefined, name);
    assert.equal(fields(metric["baseline"])["history"], "short", name);
    assert.equal(fields(metric["baseline"])["band"], null, name);
  }
});
