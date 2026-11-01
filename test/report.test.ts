import assert from "node:assert/strict";
import { test } from "node:test";
import { reportCompletion } from "../src/cli/report.ts";
import { loopReport } from "../src/report.ts";
import { fields, items } from "./service-fixture.ts";
import { endedEvent } from "./report-fixture.ts";

const now = Date.parse("2026-10-25T00:00:00.000Z");
const day = 86_400_000;
const at = (days: number): string => new Date(now - days * day).toISOString();

function completions(days: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const event = reportCompletion(
      endedEvent(`day-${String(days)}-${String(index)}`, {
        outcome: "completed",
        at: at(days),
        sequence: days * 10 + index,
      }),
    );
    assert.ok(event);
    return event;
  });
}

await test("CLV-199 daily medians and MAD bands mark a changed count and retain baseline evidence", () => {
  const previous = [1, 2, 2, 3, 2, 1, 4].flatMap((count, index) =>
    completions(index + 1.5, count),
  );
  const report = loopReport({
    now,
    since: 24,
    completions: [...previous, ...completions(0.5, 8)],
    observedSince: Date.parse(at(9)),
  });
  const metric = fields(fields(report["metrics"])["runs.completed"]);
  assert.equal(metric["value"], 8);
  assert.equal(metric["comparisonValue"], 8);
  assert.equal(metric["mark"], "outside");
  const baseline = fields(metric["baseline"]);
  assert.equal(baseline["median"], 2);
  assert.deepEqual(baseline["band"], { low: -1, high: 5 });
  assert.equal(baseline["history"], "available");
  assert.equal(baseline["days"], 7);
  assert.equal(items(baseline["evidence"]).length, previous.length);
});

await test("CLV-199 short history has no band or mark, and empty observed days count as zero", () => {
  for (const days of [null, at(4), at(6)]) {
    const report = loopReport({
      now,
      since: 24,
      completions: completions(0.5, 1),
      observedSince: days === null ? null : Date.parse(days),
    });
    const metric = fields(fields(report["metrics"])["runs.completed"]);
    const baseline = fields(metric["baseline"]);
    assert.equal(baseline["history"], days === at(6) ? "available" : "short");
    assert.equal(
      baseline["days"],
      days === null ? 0 : Math.max(0, days === at(6) ? 5 : 3),
    );
    assert.equal(baseline["band"] === null, days !== at(6));
    assert.equal(Object.hasOwn(metric, "mark"), days === at(6));
  }
});

await test("CLV-199 outcomes use terminal events and half-open windows rather than latest status time", () => {
  const events = [
    endedEvent("left", { outcome: "completed", at: at(1), sequence: 1 }),
    endedEvent("right", {
      outcome: "completed",
      at: new Date(now).toISOString(),
      sequence: 2,
    }),
    endedEvent("old", { outcome: "completed", at: at(2), sequence: 3 }),
    {
      ...endedEvent("partial", {
        outcome: "handoff_requested",
        at: at(0.5),
        sequence: 4,
      }),
      payload: { outcome: "handoff_requested", ticketStatus: "partial" },
    },
    {
      ...endedEvent("failed", { outcome: "failed", at: at(0.5), sequence: 5 }),
      type: "run.failed",
    },
    {
      ...endedEvent("cancelled", {
        outcome: "cancelled",
        at: at(0.5),
        sequence: 6,
      }),
      type: "run.cancelled",
    },
  ];
  const completions = events.flatMap((event) => {
    const completion = reportCompletion(event);
    return completion === null ? [] : [completion];
  });
  const report = loopReport({
    now,
    since: 24,
    completions,
    observedSince: Date.parse(at(9)),
  });
  const metrics = fields(report["metrics"]);
  for (const outcome of ["completed", "partial", "failed", "cancelled"])
    assert.equal(fields(metrics[`runs.${outcome}`])["value"], 1);
  assert.equal(fields(metrics["runs.blocked"])["value"], 0);
  assert.equal(reportCompletion({ type: "worker.finished" }), null);
  assert.throws(
    () =>
      reportCompletion({
        type: "run.completed",
        payload: { outcome: "unknown" },
      }),
    /invalid-report-event/,
  );
});

await test("CLV-199 multi-day counts compare a daily equivalent and unavailable sources are never zero", () => {
  const report = loopReport({
    now,
    since: 48,
    completions: completions(0.5, 4),
    observedSince: Date.parse(at(10)),
  });
  const metrics = fields(report["metrics"]);
  assert.equal(fields(metrics["runs.completed"])["comparisonValue"], 2);
  assert.equal(fields(metrics["tickets.completed"])["status"], "unavailable");
  assert.equal(fields(metrics["tickets.completed"])["value"], null);
  assert.equal(fields(report.ci.timeouts)["status"], "unavailable");
});

await test("CLV-199 ended-run costs keep turn evidence, include real zero and never substitute estimated prices", () => {
  const runs = completions(0.5, 3);
  const report = loopReport({
    now,
    since: 24,
    completions: runs,
    observedSince: Date.parse(at(9)),
    costs: [
      {
        runId: "day-0.5-0",
        turns: [
          { operationId: "turn-a", costUsd: 2 },
          { operationId: "turn-b", costUsd: 4 },
        ],
      },
      { runId: "day-0.5-1", turns: [] },
      {
        runId: "day-0.5-2",
        turns: [{ operationId: "turn-c", costUsd: null, estimatedCostUsd: 10 }],
      },
    ],
  });
  const costs = items(report["runCosts"]);
  assert.deepEqual(
    costs.map((value) => fields(value)["costUsd"]),
    [6, 0, null],
  );
  assert.deepEqual(items(fields(costs[0])["turns"]), [
    { operationId: "turn-a", costUsd: 2 },
    { operationId: "turn-b", costUsd: 4 },
  ]);
  assert.equal(
    fields(fields(report["metrics"])["cost.medianRunUsd"])["status"],
    "unavailable",
  );
  const known = loopReport({
    now,
    since: 24,
    completions: runs.slice(0, 2),
    costs: [
      {
        runId: "day-0.5-0",
        turns: [{ operationId: "turn", costUsd: 6 }],
      },
      { runId: "day-0.5-1", turns: [] },
    ],
  });
  assert.equal(
    fields(fields(known["metrics"])["cost.medianRunUsd"])["value"],
    3,
  );
});

await test("CLV-199 daemon failures produce unavailable run counts and costs", () => {
  const report = loopReport({ now, since: 24, completions: null });
  for (const metric of Object.values(fields(report["metrics"]))) {
    assert.equal(fields(metric)["status"], "unavailable");
    assert.equal(fields(metric)["value"], null);
    assert.ok(!Object.hasOwn(fields(metric), "mark"));
  }
  assert.equal(
    fields(fields(report["sources"])["daemon"])["status"],
    "unavailable",
  );
});

await test("CLV-199 GitHub throughput has independent seven-day baselines and numbered evidence", () => {
  const issues = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5].map(
    (days, index) => ({
      at: Date.parse(at(days)),
      value: 1,
      evidence: { issue: index + 1 },
    }),
  );
  const report = loopReport({
    now,
    since: 24,
    completions: [],
    github: {
      observedSince: now - 9 * day,
      issues,
      pulls: [
        { at: Date.parse(at(0.5)), value: 1, evidence: { pullRequest: 30 } },
      ],
      sources: {
        issues: { status: "available" },
        pulls: { status: "available" },
      },
    },
  });
  const metrics = fields(report["metrics"]);
  assert.equal(fields(metrics["tickets.completed"])["value"], 1);
  assert.equal(
    fields(fields(metrics["tickets.completed"])["baseline"])["median"],
    1,
  );
  assert.deepEqual(fields(metrics["pullRequests.merged"])["evidence"], [
    { pullRequest: 30 },
  ]);
  assert.equal(fields(metrics["pullRequests.merged"])["mark"], "outside");
});

await test("CLV-199 each ended-run cost carries its historical daily median and band", () => {
  const events = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5].flatMap((days) =>
    completions(days, 1),
  );
  const costs = events.map((event, index) => ({
    runId: event.runId,
    turns: [
      { operationId: `turn-${String(index)}`, costUsd: index === 0 ? 99 : 1 },
    ],
  }));
  const report = loopReport({
    now,
    since: 24,
    completions: events,
    observedSince: now - 9 * day,
    costs,
  });
  const cost = fields(items(report["runCosts"])[0]);
  assert.equal(fields(cost["baseline"])["median"], 1);
  assert.equal(cost["mark"], "outside");
});

await test("CLV-199 finite prices never produce an available nonfinite total or median", () => {
  const events = completions(0.5, 1);
  const expensive = {
    runId: "day-0.5-0",
    turns: [{ operationId: "large", costUsd: 1e308 }],
  };
  const finite = loopReport({
    now,
    since: 24,
    completions: events,
    costs: [expensive],
  });
  assert.equal(
    fields(fields(finite["metrics"])["cost.medianRunUsd"])["value"],
    1e308,
  );
  const overflowing = loopReport({
    now,
    since: 24,
    completions: events,
    costs: [
      {
        ...expensive,
        turns: [
          ...expensive.turns,
          { operationId: "also-large", costUsd: 1e308 },
        ],
      },
    ],
  });
  assert.equal(
    fields(fields(overflowing["metrics"])["cost.medianRunUsd"])["status"],
    "unavailable",
  );
});

await test("CLV-199 an unrepresentable MAD band is unavailable and cannot mark an outlier", () => {
  const events = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5].flatMap((days) =>
    completions(days, 1),
  );
  const prices = [1, 0, 0, 0, 1e308, 1e308, 1e308, 1.7e308];
  const costs = events.map((event, index) => ({
    runId: event.runId,
    turns: [{ operationId: event.runId, costUsd: prices[index] ?? null }],
  }));
  const metric = fields(
    fields(
      loopReport({
        now,
        since: 24,
        completions: events,
        observedSince: now - 9 * day,
        costs,
      })["metrics"],
    )["cost.medianRunUsd"],
  );
  assert.equal(fields(metric["baseline"])["history"], "unavailable");
  assert.equal(fields(metric["baseline"])["band"], null);
  assert.ok(!Object.hasOwn(metric, "mark"));
});

await test("CLV-199 unknown explicit outcomes and malformed completion identities are refused", () => {
  assert.throws(
    () =>
      reportCompletion({
        type: "run.completed",
        runId: "invalid",
        sequence: 1,
        recordedAt: at(0.5),
        payload: { outcome: "completed" },
      }),
    /invalid-report-event/,
  );
  assert.throws(
    () =>
      reportCompletion({
        type: "run.completed",
        sequence: 1,
        recordedAt: at(0.5),
        payload: {},
      }),
    /invalid-report-event/,
  );
});
