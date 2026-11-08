import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { reviewDay } from "../templates/review-day/review-day.ts";
import { fields } from "../templates/review-day/review-day/facts.ts";
import { turnFacts } from "../templates/review-day/review-day/input.ts";
import {
  completed,
  effects,
  input,
  methods,
  promptFacts,
} from "../templates/review-day/review-day/scenarios.ts";

function evidence(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    runId: `run-${String(index).padStart(32, "0")}`,
    sequence: 10000 + index,
  }));
}

function metric(value: number) {
  return {
    status: "available",
    value,
    comparisonValue: value,
    baseline: {
      history: "available",
      days: 7,
      median: value + 1,
      band: { low: value - 2, high: value + 4 },
      evidence: evidence(150),
    },
    mark: "outside",
    evidence: evidence(150),
  };
}

function largeReport() {
  return {
    schemaVersion: 1,
    kind: "loop-report",
    window: {
      start: "2026-11-07T14:05:00.000Z",
      end: "2026-11-08T14:05:00.000Z",
      hours: 24,
    },
    semantics: { costs: "lifetime-turn-cost-attributed-at-run-end" },
    metrics: {
      "runs.completed": metric(7),
      "phases.workerTurn.medianMinutes": metric(51),
      "phases.codeReview.medianMinutes": metric(46),
      "phases.merge.medianMinutes": metric(22),
      "flow.busyLaneShare": metric(0.75),
      "cost.medianRunUsd": metric(19.4),
      "leadTime.medianHours": metric(9.5),
      "tickets.completed": metric(6),
    },
    quality: {
      reviewScore: { round1: metric(80) },
      reopenedTickets: metric(1),
    },
    ci: { jobMinutes: { localMacos: metric(12) }, timeouts: metric(2) },
    operator: { merges: metric(4) },
  };
}

const costs = [4.5, null, 12, 0, 30.25, null, 7, 9];

const omissions = [
  "reviews",
  "report.metrics.*.evidence",
  "report.runCosts.mostCostly",
  "improvements",
];

function keptRun(index: number) {
  return {
    runId: `run-${String(index)}`,
    ticketId: String(600 + index),
    outcome: "completed",
    completedAt: "2026-11-08T10:00:00.000Z",
    costUsd: costs.at(index) ?? null,
    ...(index === 4 ? { mark: "outside" } : {}),
  };
}

function costRun(index: number) {
  return Object.assign(keptRun(index), {
    turns: [{ operationId: `turn-${String(index)}`, costUsd: costs.at(index) }],
    evidence: { runId: `run-${String(index)}`, sequence: index },
    baseline: { history: "short", days: 3, evidence: evidence(3) },
  });
}

function compact(value: number, unit: string) {
  return {
    status: "available",
    value,
    comparisonValue: value,
    baseline: {
      history: "available",
      days: 7,
      median: value + 1,
      band: { low: value - 2, high: value + 4 },
    },
    mark: "outside",
    count: 150,
    evidence: evidence(3),
    unit,
  };
}

function sampled(index: number) {
  return {
    status: "available",
    value: index,
    comparisonValue: index,
    evidence: Array.from({ length: 4 }, () => ({
      workflowId: `workflow-${String(index).padStart(40, "0")}`,
      runIds: evidence(2).map((item) => item.runId),
    })),
  };
}

function turnPayloads(requests: ReturnType<typeof fakeStepBridge>["requests"]) {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === "run-turn"
      ? [request[1].payload]
      : [],
  );
}

await test("CLV-323 a full improvement list blocks the review before any turn", async () => {
  using bridge = fakeStepBridge({
    effects: {
      ...effects(),
      "github issues": [
        completed([]),
        completed(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            body: "Loop: merge",
          })),
        ),
      ],
    },
  });
  const outcome = await reviewDay(input);
  assert.equal(outcome.kind, "blocked");
  assert.equal(
    "reason" in outcome ? outcome.reason : null,
    "too-many-improvements",
  );
  assert.deepEqual(methods(bridge.requests), [
    "run:report",
    "issues",
    "issues",
  ]);
});

await test("CLV-325 a 200000-byte report reaches both turns in at most 48000 bytes with each metric value", async () => {
  const report = largeReport();
  assert.ok(JSON.stringify(report).length >= 200000);
  using bridge = fakeStepBridge({
    effects: Object.assign(effects(), {
      "command run:report": [completed(report)],
    }),
  });
  assert.equal((await reviewDay(input)).kind, "handoff_requested");
  const payloads = turnPayloads(bridge.requests);
  assert.equal(payloads.length, 2);
  const values = Object.entries(report.metrics)
    .map(([name, value]) => [name, value.value] as const)
    .concat([
      ["quality.reviewScore.round1", 80],
      ["quality.reopenedTickets", 1],
      ["ci.jobMinutes.localMacos", 12],
      ["ci.timeouts", 2],
      ["operator.merges", 4],
    ]);
  for (const payload of payloads) {
    assert.ok(Buffer.byteLength(payload) <= 48000, String(payload.length));
    const shown = fields(promptFacts(payload));
    const metrics = fields(fields(shown["report"])["metrics"]);
    for (const [name, value] of values)
      assert.equal(fields(metrics[name])["value"], value, name);
  }
});

await test("CLV-325 the turn reads each metric with its value, unit, count and baseline, and run cost totals", async () => {
  const report = {
    window: largeReport().window,
    semantics: largeReport().semantics,
    metrics: {
      "phases.merge.medianMinutes": metric(22),
      mergeMinutes: { value: 30, mark: "outside" },
    },
    runCosts: costs.map((_, index) => costRun(index)),
    quality: {
      jobLogs: { read: 3, notRead: 1, limit: 20, maximumBytes: 1048576 },
      reviewScore: { round1: metric(80) },
    },
    ci: { jobLimitShare: { hostedLinux: metric(0.4) } },
    operator: { labelChanges: metric(2) },
  };
  using bridge = fakeStepBridge({
    effects: Object.assign(effects(), {
      "command run:report": [completed(report)],
    }),
  });
  assert.equal((await reviewDay(input)).kind, "handoff_requested");
  for (const payload of turnPayloads(bridge.requests))
    assert.deepEqual(fields(promptFacts(payload))["report"], {
      window: report.window,
      semantics: report.semantics,
      metrics: {
        "phases.merge.medianMinutes": compact(22, "minutes"),
        mergeMinutes: { value: 30, mark: "outside", unit: "minutes" },
        "quality.reviewScore.round1": compact(80, "score"),
        "ci.jobLimitShare.hostedLinux": compact(0.4, "share"),
        "operator.labelChanges": compact(2, "count"),
      },
      jobLogs: report.quality.jobLogs,
      runCosts: {
        runs: 8,
        knownSpendUsd: 62.75,
        runsWithoutCost: 2,
        mostCostly: [4, 2, 7, 6, 0].map((index) => keptRun(index)),
      },
    });
});

await test("CLV-325 the turn leaves out the review list first, then the other lists, and keeps the numbers", async () => {
  const issues = (label: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      url: `https://github.com/acme/demo/issues/${String(index + 1)}`,
      body: `Loop: ${label}-${String(index)}\n\n${"é".repeat(4000)}`,
    }));
  const report = Object.assign(largeReport(), {
    runCosts: [{ runId: "run-1", costUsd: 3 }],
  });
  for (const scenario of [
    { improvements: 2, omitted: ["reviews"] },
    { improvements: 20, omitted: omissions },
  ]) {
    using bridge = fakeStepBridge({
      effects: Object.assign(effects(), {
        "command run:report": [completed(report)],
        "github issues": [
          completed(issues("review", 7)),
          completed(issues("loop", scenario.improvements)),
        ],
      }),
    });
    assert.equal((await reviewDay(input)).kind, "handoff_requested");
    for (const payload of turnPayloads(bridge.requests)) {
      assert.ok(Buffer.byteLength(payload) <= 48000);
      assert.match(
        payload,
        /A list named in omitted .+ treat it as unknown, never as empty\./,
      );
      const shown = fields(promptFacts(payload));
      const costs = fields(fields(shown["report"])["runCosts"]);
      assert.deepEqual(shown["omitted"], scenario.omitted);
      assert.equal(shown["reviews"], null);
      assert.equal(costs["knownSpendUsd"], 3);
      assert.equal(
        fields(fields(fields(shown["report"])["metrics"])["runs.completed"])[
          "value"
        ],
        7,
      );
      assert.deepEqual(
        [costs["mostCostly"] === null, shown["improvements"] === null],
        [scenario.omitted.length > 1, scenario.omitted.length > 1],
      );
    }
  }
});

await test("CLV-325 each metric keeps its first 3 evidence items, and each list in an item keeps its first 3 entries", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    issue: index,
    runIds: evidence(10).map((item) => item.runId),
    testNames: ["first", "second", "third", "fourth"],
  }));
  using bridge = fakeStepBridge({
    effects: Object.assign(effects(), {
      "command run:report": [
        completed({
          metrics: { "tickets.waiting": { value: 5, evidence: items } },
        }),
      ],
    }),
  });
  assert.equal((await reviewDay(input)).kind, "handoff_requested");
  for (const payload of turnPayloads(bridge.requests))
    assert.deepEqual(
      fields(fields(fields(promptFacts(payload))["report"])["metrics"])[
        "tickets.waiting"
      ],
      {
        value: 5,
        count: 5,
        unit: "count",
        evidence: items.slice(0, 3).map((item) => ({
          issue: item.issue,
          runIds: item.runIds.slice(0, 3),
          testNames: ["first", "second", "third"],
        })),
      },
    );
});

await test("CLV-325 the turn leaves out the evidence samples after the review list and before the run costs", async () => {
  const metrics = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => [
      `flow.lanes.workflow-${String(index)}`,
      sampled(index),
    ]),
  );
  using bridge = fakeStepBridge({
    effects: Object.assign(effects(), {
      "command run:report": [
        completed({ metrics, runCosts: [{ runId: "run-1", costUsd: 3 }] }),
      ],
    }),
  });
  assert.equal((await reviewDay(input)).kind, "handoff_requested");
  for (const payload of turnPayloads(bridge.requests)) {
    assert.ok(Buffer.byteLength(payload) <= 48000);
    const shown = fields(promptFacts(payload));
    const report = fields(shown["report"]);
    assert.deepEqual(shown["omitted"], [
      "reviews",
      "report.metrics.*.evidence",
    ]);
    assert.deepEqual(fields(report["runCosts"])["mostCostly"], [
      { runId: "run-1", costUsd: 3 },
    ]);
    for (const [name, value] of Object.entries(metrics))
      assert.deepEqual(fields(fields(report["metrics"])[name]), {
        status: "available",
        value: value.value,
        comparisonValue: value.value,
        count: 4,
        evidence: null,
        unit: "count",
      });
  }
});

await test("CLV-325 turnFacts gives typed forms that leave out one more list each", () => {
  const forms = turnFacts({
    report: { metrics: { "runs.completed": metric(7) } },
    reviews: [],
    improvements: [],
  });
  assert.deepEqual(
    forms.map((form) => form.omitted),
    [0, 1, 2, 3, 4].map((count) => omissions.slice(0, count)),
  );
  assert.deepEqual(
    forms.map((form) => form.report.metrics["runs.completed"]?.["count"]),
    [150, 150, 150, 150, 150],
  );
});

await test("CLV-325 a report whose numbers alone pass the bound blocks before any turn and names the size", async () => {
  const metrics = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [
      `flow.scheduleSkips.workflow-${String(index)}`,
      { status: "available", value: index, comparisonValue: index },
    ]),
  );
  using bridge = fakeStepBridge({
    effects: Object.assign(effects(), {
      "command run:report": [completed({ metrics })],
    }),
  });
  const outcome = await reviewDay(input);
  const reason = "reason" in outcome ? outcome.reason : "";
  assert.equal(outcome.kind, "blocked");
  assert.match(reason, /^review-input-too-large: \d+ bytes, limit 48000$/);
  assert.ok(Number(/\d+/.exec(reason)?.[0]) > 48000);
  assert.deepEqual(methods(bridge.requests), [
    "run:report",
    "issues",
    "issues",
    "discard",
  ]);
});
