import assert from "node:assert/strict";
import { test } from "node:test";
import { loopReport } from "../src/report.ts";
import { fields } from "./service-fixture.ts";

const hour = 3_600_000;
const now = Date.parse("2026-10-25T00:00:00Z");
const window = { since: 24, now, observedSince: now - 10 * 24 * hour };
const run = (
  runId: string,
  input: {
    readonly start: number;
    readonly end: number | null;
    readonly workflowId?: string;
  },
) => ({
  runId,
  start: now + input.start * hour,
  end: input.end === null ? null : now + input.end * hour,
  workflowId: input.workflowId ?? "queue",
});
const ended = (
  runId: string,
  input: {
    readonly at: number;
    readonly outcome:
      "completed" | "failed" | "partial" | "blocked" | "cancelled";
    readonly sequence: number;
  },
) => ({
  runId,
  at: now + input.at * hour,
  outcome: input.outcome,
  sequence: input.sequence,
});

await test("CLV-244 peak includes any workflow, ongoing and crossing runs with half-open boundaries", () => {
  const report = loopReport({
    ...window,
    completions: [],
    flow: {
      queue: { workflowId: "queue", lanes: 2 },
      runs: [
        run("crossing", { start: -30, end: -4 }),
        run("other", { start: -20, end: -11, workflowId: "other" }),
        run("ongoing", { start: -11, end: null }),
        run("boundary", { start: 0, end: null }),
      ],
    },
  });
  const peak = fields(fields(report.metrics)["flow.peakActiveRuns"]);
  assert.equal(peak["value"], 2);
  assert.deepEqual(peak["evidence"], [{ runIds: ["crossing", "other"] }]);
});

await test("CLV-244 unsuccessful streak uses terminal order and completed resets the longest streak", () => {
  const completions = [
    ended("prior", { at: -25, outcome: "failed", sequence: 1 }),
    ended("a", { at: -23, outcome: "partial", sequence: 2 }),
    ended("b", { at: -22, outcome: "blocked", sequence: 3 }),
    ended("reset", { at: -21, outcome: "completed", sequence: 4 }),
    ended("c", { at: -20, outcome: "failed", sequence: 5 }),
    ended("d", { at: -19, outcome: "cancelled", sequence: 6 }),
    ended("e", { at: -18, outcome: "partial", sequence: 7 }),
    ended("last-reset", { at: -17, outcome: "completed", sequence: 8 }),
    ended("last", { at: -1, outcome: "failed", sequence: 9 }),
    ended("future", { at: 0, outcome: "completed", sequence: 10 }),
  ].reverse();
  const report = loopReport({ ...window, completions });
  const current = fields(
    fields(report.metrics)["flow.unsuccessfulStreak.current"],
  );
  const longest = fields(
    fields(report.metrics)["flow.unsuccessfulStreak.longest"],
  );
  assert.equal(current["value"], 1);
  assert.deepEqual(current["evidence"], [{ runIds: ["last"] }]);
  assert.equal(longest["value"], 3);
  assert.deepEqual(longest["evidence"], [{ runIds: ["c", "d", "e"] }]);
});

await test("CLV-244 schedule skips are counted separately for each workflow", () => {
  const flow = {
    queue: null,
    runs: [],
    skips: [
      { workflowId: "queue", at: now - hour, sequence: 1 },
      { workflowId: "queue", at: now - 2 * hour, sequence: 2 },
      { workflowId: "other", at: now - hour, sequence: 3 },
      { workflowId: "queue", at: now, sequence: 4 },
      { workflowId: "old", at: now - 25 * hour, sequence: 5 },
    ],
  };
  const report = loopReport({ ...window, completions: [], flow });
  const skips = fields(fields(report.metrics)["flow.scheduleSkips.queue"]);
  assert.equal(skips["value"], 2);
  assert.equal(
    fields(fields(report.metrics)["flow.scheduleSkips.other"])["value"],
    1,
  );
  assert.equal(
    fields(fields(report.metrics)["flow.scheduleSkips.old"])["value"],
    0,
  );
  assert.deepEqual(skips["evidence"], [
    { workflowId: "queue", sequence: 1 },
    { workflowId: "queue", sequence: 2 },
  ]);
});

await test("CLV-244 every flow value carries a seven-day baseline, evidence and outside mark", () => {
  const flow = {
    queue: { workflowId: "queue", lanes: 2 },
    runs: [
      run("a", { start: -24, end: -20 }),
      run("b", { start: -24, end: -23 }),
    ],
    skips: [{ workflowId: "queue", at: now - hour, sequence: 3 }],
  };
  const ready = [
    {
      issue: 500,
      intervals: [{ start: now - 22 * hour, end: now - 17 * hour }],
      dependencies: [{ issue: 499, closedAt: now - 19 * hour }],
    },
    {
      issue: 501,
      intervals: [{ start: now - 24 * hour, end: now - 23 * hour }],
      dependencies: [],
    },
  ];
  const report = loopReport({
    ...window,
    flow,
    completions: [
      ended("a", { at: -20, outcome: "failed", sequence: 1 }),
      ended("b", { at: -23, outcome: "failed", sequence: 2 }),
    ],
    github: {
      observedSince: window.observedSince,
      issues: [],
      pulls: [],
      sources: {},
      ready,
    },
  });
  const metrics = fields(report.metrics);
  const names = Object.keys(metrics).filter((name) => name.startsWith("flow."));
  assert.equal(names.length, 9);
  for (const name of names) {
    const metric = fields(metrics[name]);
    assert.deepEqual(
      fields(metric["baseline"])["band"],
      { low: 0, high: 0 },
      name,
    );
    assert.equal(fields(metric["baseline"])["median"], 0, name);
    assert.equal(fields(metric["baseline"])["days"], 7, name);
    assert.equal(metric["mark"], "outside", name);
    assert.ok(Array.isArray(metric["evidence"]), name);
    assert.ok(Array.isArray(fields(metric["baseline"])["evidence"]), name);
  }
});

await test("CLV-244 unreadable old run identity invalidates only affected baseline days", () => {
  const report = loopReport({
    ...window,
    completions: [],
    flow: {
      queue: { workflowId: "queue", lanes: 2 },
      runs: [{ ...run("unknown", { start: -80, end: -79 }), workflowId: null }],
      skips: [],
    },
    github: {
      observedSince: window.observedSince,
      issues: [],
      pulls: [],
      sources: {},
      ready: [
        {
          issue: 500,
          intervals: [{ start: now - hour, end: null }],
          dependencies: [],
        },
      ],
    },
  });
  const metrics = fields(report.metrics);
  assert.equal(
    fields(metrics["flow.idleLaneHoursWithReadyTicket"])["value"],
    1,
  );
  assert.equal(
    fields(fields(metrics["flow.readyWaitHours.noLane"])["baseline"])["days"],
    6,
  );
  assert.equal(
    fields(fields(metrics["flow.readyWaitHours.dependency"])["baseline"])[
      "days"
    ],
    7,
  );
});

await test("CLV-244 short observed history gives no baseline mark for every flow value", () => {
  const flow = {
    queue: { workflowId: "queue", lanes: 2 },
    runs: [],
    skips: [],
  };
  const short = loopReport({
    ...window,
    flow,
    observedSince: now - hour,
    completions: [],
  });
  for (const [name, value] of Object.entries(short.metrics).filter(([name]) =>
    name.startsWith("flow."),
  )) {
    assert.equal(fields(fields(value)["baseline"])["history"], "short", name);
    assert.equal(fields(value)["mark"], undefined, name);
  }
});
