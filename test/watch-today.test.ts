import assert from "node:assert/strict";
import { test } from "node:test";
import { localDays, loadedRun, todayOf } from "../src/cli/watch-today.ts";
import { reportCompletion, reportCost } from "../src/cli/report.ts";
import { loopReport } from "../src/report.ts";
import { watchReader } from "../src/cli/watch-reads.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";
import {
  endedRun,
  localTime,
  threeDayRuns,
  type TodayRunFields,
} from "./watch-today-fixture.ts";

const now = new Date(localTime(4, 15)).toISOString();
const workflows = ["develop-issue", "idea", "review-day"];

await test("CLV-289 the numbers of the day count the runs that ended today, yesterday and on each of the last 7 days", () => {
  const today = todayOf({ now, runs: threeDayRuns(), workflows });
  assert.equal(today.completed, 3);
  assert.equal(today.stopped, 1);
  assert.equal(today.costUsd, 25);
  assert.equal(today.costPerCompletedRunUsd, 25 / 3);
  assert.deepEqual(today.yesterday, { completed: 1, costUsd: 8 });
  assert.deepEqual(today.days, [
    { date: "2026-10-29", completed: 0 },
    { date: "2026-10-30", completed: 0 },
    { date: "2026-10-31", completed: 0 },
    { date: "2026-11-01", completed: 0 },
    { date: "2026-11-02", completed: 1 },
    { date: "2026-11-03", completed: 1 },
    { date: "2026-11-04", completed: 3 },
  ]);
  assert.deepEqual(today.workflows, [
    { workflowId: "develop-issue", completed: 2, costUsd: 24.5 },
    { workflowId: "idea", completed: 1, costUsd: 0.5 },
    { workflowId: "review-day", completed: 0, costUsd: 0 },
  ]);
});

function reportOfToday(runs: readonly TodayRunFields[]) {
  const end = Date.parse(now);
  return loopReport({
    since: (end - localTime(4, 0)) / 3_600_000,
    now: end,
    completions: runs.flatMap((run) =>
      run.events.flatMap((event) => reportCompletion(event) ?? []),
    ),
    costs: runs.map((run) =>
      reportCost(String(run.status["runId"]), run.status),
    ),
  });
}

await test("CLV-289 the numbers of the day are the numbers of cloving report for the same runs", () => {
  const runs = threeDayRuns();
  const today = todayOf({ now, runs, workflows });
  const report = reportOfToday(runs);
  const metrics: Readonly<Record<string, { readonly value: number | null }>> =
    report.metrics;
  assert.equal(today.completed, metrics["runs.completed"]?.value);
  assert.equal(
    today.stopped,
    ["failed", "cancelled", "blocked"]
      .map((outcome) => Number(metrics[`runs.${outcome}`]?.value))
      .reduce((sum, value) => sum + value, 0),
  );
  assert.equal(
    today.costUsd,
    report.runCosts.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  );
});

await test("CLV-289 an unknown run cost makes the cost of its day and its workflow unknown", () => {
  const runs = [
    ...threeDayRuns(),
    endedRun("today-unknown", {
      end: "completed",
      at: localTime(4, 14),
      workflowId: "idea",
      costs: [null],
    }),
  ];
  const today = todayOf({ now, runs, workflows });
  assert.equal(today.completed, 4);
  assert.equal(today.costUsd, null);
  assert.equal(today.costPerCompletedRunUsd, null);
  assert.deepEqual(today.workflows[1], {
    workflowId: "idea",
    completed: 2,
    costUsd: null,
  });
  assert.deepEqual(today.workflows[0], {
    workflowId: "develop-issue",
    completed: 2,
    costUsd: 24.5,
  });
});

await test("CLV-289 a day with no completed run has no cost per completed run, and a run of an unregistered workflow gets its own row", () => {
  const runs = [
    endedRun("removed-1", {
      end: "failed",
      at: localTime(4, 10),
      workflowId: "removed",
      costs: [1.5],
    }),
  ];
  const today = todayOf({ now, runs, workflows: ["develop-issue"] });
  assert.equal(today.completed, 0);
  assert.equal(today.stopped, 1);
  assert.equal(today.costUsd, 1.5);
  assert.equal(today.costPerCompletedRunUsd, null);
  assert.deepEqual(today.workflows, [
    { workflowId: "develop-issue", completed: 0, costUsd: 0 },
    { workflowId: "removed", completed: 0, costUsd: 1.5 },
  ]);
});

await test("CLV-289 a terminal event that cloving report refuses does not count", () => {
  const [valid] = threeDayRuns();
  assert.ok(valid);
  const refused: TodayRunFields = {
    status: { ...valid.status, runId: "refused-1" },
    events: [
      {
        runId: "refused-1",
        sequence: 2,
        type: "run.completed",
        recordedAt: new Date(localTime(4, 10)).toISOString(),
        payload: { outcome: "unknown-outcome" },
      },
    ],
  };
  assert.throws(() => reportCompletion(refused.events[0] ?? {}), {
    message: "invalid-report-event",
  });
  const today = todayOf({ now, runs: [valid, refused], workflows });
  assert.equal(today.completed, 1);
  assert.equal(today.costUsd, 10);
});

function inZone(zone: string, body: () => void): void {
  const previous = process.env["TZ"];
  process.env["TZ"] = zone;
  try {
    body();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env["TZ"] = previous;
  }
}

await test("CLV-289 days start at local midnight of the computer, also across a change of the clock", () => {
  inZone("America/New_York", () => {
    const days = localDays("2026-11-04T03:30:00.000Z", 7);
    assert.deepEqual(
      days.map((day) => [
        day.date,
        new Date(day.start).toISOString(),
        new Date(day.end).toISOString(),
      ]),
      [
        ["2026-10-28", "2026-10-28T04:00:00.000Z", "2026-10-29T04:00:00.000Z"],
        ["2026-10-29", "2026-10-29T04:00:00.000Z", "2026-10-30T04:00:00.000Z"],
        ["2026-10-30", "2026-10-30T04:00:00.000Z", "2026-10-31T04:00:00.000Z"],
        ["2026-10-31", "2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"],
        ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
        ["2026-11-02", "2026-11-02T05:00:00.000Z", "2026-11-03T05:00:00.000Z"],
        ["2026-11-03", "2026-11-03T05:00:00.000Z", "2026-11-04T05:00:00.000Z"],
      ],
    );
  });
});

await test("CLV-289 the watch reads every run of the oldest day, also when the 7 days are longer than 168 hours", () => {
  inZone("America/New_York", () => {
    const now = "2026-11-07T04:30:00.000Z";
    assert.equal(loadedRun("2026-10-31T04:10:00.000Z", now), true);
    assert.equal(loadedRun("2026-10-31T03:50:00.000Z", now), false);
    assert.equal(loadedRun("2026-11-07T03:30:00.000Z", now), true);
    assert.equal(loadedRun("2026-11-07T05:30:00.000Z", now), false);
    assert.equal(loadedRun(null, now), false);
  });
});

await test("CLV-289 the watch data has the numbers of the day from the runs of the service", async () => {
  const at = Date.now() - 60_000;
  const runs = [
    endedRun("served-1", { end: "completed", at, costs: [4, 6] }),
    endedRun("served-2", {
      end: "failed",
      at,
      workflowId: "idea",
      costs: [2],
    }),
  ];
  const { answer } = watchReplies({
    runs: runs.map((run) => run.status),
    eventsByRun: Object.fromEntries(
      runs.map((run) => [String(run.status["runId"]), run.events]),
    ),
    workflows: ["develop-issue", "idea"],
  });
  await withWatchService(answer, async (watch, runtimeDirectory) => {
    const read = await watchReader(runtimeDirectory).read(
      new Date(at).toISOString(),
    );
    const today = read.today;
    assert.ok(today);
    assert.equal(today.completed, 1);
    assert.equal(today.stopped, 1);
    assert.equal(today.costUsd, 12);
    assert.equal(today.costPerCompletedRunUsd, 12);
    assert.deepEqual(today.workflows, [
      { workflowId: "develop-issue", completed: 1, costUsd: 10 },
      { workflowId: "idea", completed: 0, costUsd: 2 },
    ]);
    const data = await watchData(watch.address);
    assert.deepEqual(
      data["today"],
      todayOf({
        now: String(data["updatedAt"]),
        runs,
        workflows: ["develop-issue", "idea"],
      }),
    );
  });
});
