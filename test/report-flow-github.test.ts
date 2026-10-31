import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import { reportCommand } from "../src/cli/report.ts";
import { fields } from "./service-fixture.ts";
import {
  githubReportFixture,
  issue,
  since,
  output,
} from "./report-github-fixture.ts";
import { reportReply, withReportSource } from "./report-fixture.ts";

const now = Date.parse("2026-10-25T00:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const label = (event: string, hours: number) => ({
  event,
  created_at: at(hours),
  label: { name: "cloving: ready" },
});
const events = [
  ["run.started", "a", -30],
  ["run.started", "b", -24],
  ["run.completed", "b", -11],
  ["run.completed", "a", -4],
].map(([type, runId, hours], index) => ({
  type,
  runId,
  sequence: index + 1,
  payload: {},
  recordedAt: at(Number(hours)),
}));
const reply = reportReply(
  events,
  ["a", "b"].map((runId) => ({ runId, workflowId: "queue" })),
);
const daemon = (request: Parameters<typeof reply>[0]) =>
  request.operation === "status" && request.parameters["runId"] === undefined
    ? {
        kind: "result" as const,
        result: { queue: { workflowId: "queue", lanes: 2 } },
      }
    : reply(request);

async function scenario(scene: ReturnType<typeof githubReportFixture>) {
  return withReportSource(daemon, async (harness) => {
    const output: string[] = [];
    await reportCommand(
      { since: 24, json: true },
      {
        now,
        runtimeDirectory: harness.runtimeDirectory,
        workingDirectory: harness.projectDirectory,
        watchPr: scene.settings,
        terminal: { out: (text) => output.push(text) },
      },
    );
    return fields(fields(JSON.parse(output.join("")))["metrics"]);
  });
}

await test("CLV-244 stand-in gh distinguishes dependency wait from eligible idle lane hours", async () => {
  const scene = githubReportFixture({
    readyIssues: [[issue(500)]],
    timelines: { 500: [[label("labeled", -9), label("unlabeled", -4)]] },
    details: {
      500: issue(500, { body: "## Dependencies\nNeeds #499." }),
      499: issue(499, { closed_at: at(-6) }),
    },
  });
  const metrics = await scenario(scene);
  assert.equal(fields(metrics["flow.busyLaneShare"])["value"], 0.6875);
  assert.equal(
    fields(metrics["flow.idleLaneHoursWithReadyTicket"])["value"],
    2,
  );
  assert.equal(fields(metrics["flow.readyWaitHours.dependency"])["value"], 3);
  assert.equal(fields(metrics["flow.readyWaitHours.noLane"])["value"], 0);
  assert.deepEqual(
    fields(metrics["flow.readyWaitHours.dependency"])["evidence"],
    [{ issue: 500, dependencies: [499] }],
  );
  assert.ok(
    scene.commands.some((command) =>
      command.includes("repos/fixture/demo/issues/499"),
    ),
  );
});

await test("CLV-244 ready labels without Needs wait only while every lane is occupied", async () => {
  const scene = githubReportFixture({
    readyIssues: [[issue(501)]],
    timelines: { 501: [[label("labeled", -23), label("unlabeled", -22)]] },
    details: { 501: issue(501, { body: "No dependencies." }) },
  });
  const metrics = await scenario(scene);
  assert.equal(fields(metrics["flow.readyWaitHours.dependency"])["value"], 0);
  assert.equal(fields(metrics["flow.readyWaitHours.noLane"])["value"], 1);
  assert.equal(
    fields(metrics["flow.idleLaneHoursWithReadyTicket"])["value"],
    0,
  );
});

await test("CLV-244 unreadable GitHub timeline leaves ready values unavailable and daemon values available", async () => {
  const scene = githubReportFixture({
    readyIssues: [[issue(500)]],
    timelineFailures: [
      { ...output(null), status: 1, stderr: "Forbidden (HTTP 403)" },
    ],
  });
  const metrics = await scenario(scene);
  for (const name of [
    "flow.readyWaitHours.dependency",
    "flow.readyWaitHours.noLane",
    "flow.idleLaneHoursWithReadyTicket",
  ])
    assert.equal(fields(metrics[name])["status"], "unavailable", name);
  assert.equal(fields(metrics["flow.busyLaneShare"])["value"], 0.6875);
  assert.equal(fields(metrics["flow.peakActiveRuns"])["value"], 2);
  assert.equal(scene.timelineAttempts(), 1);
});

await test("CLV-244 ready timeline pagination and current dependency body are read through the retry boundary", async () => {
  const scene = githubReportFixture({
    readyIssues: [[issue(500)]],
    details: { 500: issue(500, { body: "" }) },
    timelines: {
      500: [
        Array.from({ length: 100 }, () => ({ event: "commented" })),
        [label("labeled", -10)],
      ],
    },
    timelineFailures: [
      { ...output(null), status: 1, stderr: "Failed (HTTP 502)" },
    ],
  });
  const result = await readReportGithub({
    since,
    settings: scene.settings,
    retryMilliseconds: 1,
  });
  assert.deepEqual(fields(result)["ready"], [
    {
      issue: 500,
      intervals: [{ start: Date.parse(at(-10)), end: null }],
      dependencies: [],
    },
  ]);
  assert.equal(scene.timelineAttempts(), 3);
});

await test("CLV-244 removed and reapplied ready labels retain separate intervals and an open Needs issue blocks both", async () => {
  const scene = githubReportFixture({
    readyIssues: [[issue(500), issue(501, { pull_request: {} })]],
    timelines: {
      500: [
        [
          label("labeled", -10),
          label("labeled", -9),
          label("unlabeled", -8),
          label("labeled", -5),
        ],
      ],
    },
    details: {
      500: issue(500, { body: "## Dependencies\nNeeds #499." }),
      499: issue(499, { state: "open", closed_at: null }),
    },
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.deepEqual(result.ready, [
    {
      issue: 500,
      intervals: [
        { start: Date.parse(at(-10)), end: Date.parse(at(-8)) },
        { start: Date.parse(at(-5)), end: null },
      ],
      dependencies: [{ issue: 499, closedAt: null }],
    },
  ]);
  const metrics = await scenario(
    githubReportFixture({
      readyIssues: [[issue(500)]],
      timelines: { 500: [[label("labeled", -9), label("unlabeled", -4)]] },
      details: {
        500: issue(500, { body: "## Dependencies\nNeeds #499." }),
        499: issue(499, { state: "open", closed_at: null }),
      },
    }),
  );
  assert.equal(fields(metrics["flow.readyWaitHours.dependency"])["value"], 5);
  assert.equal(
    fields(metrics["flow.idleLaneHoursWithReadyTicket"])["value"],
    0,
  );
});

await test("CLV-244 unreadable or mismatched current bodies and dependencies make readiness unavailable", async () => {
  for (const details of [
    { 500: null },
    { 500: issue(501, { body: "" }) },
    { 500: issue(500, { body: 5 }) },
    {
      500: issue(500, { body: "## Dependencies\nNeeds #499." }),
      499: issue(499, { state: "invalid" }),
    },
    {
      500: issue(500, { body: "## Dependencies\nNeeds #499." }),
      499: issue(499, { closed_at: "invalid" }),
    },
  ]) {
    const result = await readReportGithub({
      since,
      settings: githubReportFixture({
        readyIssues: [[issue(500)]],
        timelines: { 500: [[label("labeled", -5)]] },
        details,
      }).settings,
    });
    assert.equal(result.ready, null);
    assert.equal(result.sources.ready.status, "unavailable");
    assert.equal(result.sources.pulls.status, "available");
  }
});

await test("CLV-244 ready discovery pages every issue and rejects repeated pages without partial results", async () => {
  const first = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const scene = githubReportFixture({
    readyIssues: [first, [issue(500)]],
    timelines: { 500: [[label("unlabeled", -8), label("labeled", -5)]] },
    details: { 500: issue(500, { body: null }) },
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.deepEqual(result.ready, [
    {
      issue: 500,
      intervals: [{ start: Date.parse(at(-5)), end: null }],
      dependencies: [],
    },
  ]);
  const repeated = await readReportGithub({
    since,
    settings: githubReportFixture({ readyIssues: [first, first] }).settings,
  });
  assert.equal(repeated.ready, null);
  assert.equal(repeated.sources.ready.status, "unavailable");
});

await test("CLV-244 unsafe dependency numbers and pull-request bodies cannot supply issue readiness", async () => {
  for (const detail of [
    issue(500, { body: "## Dependencies\nNeeds #99999999999999999999." }),
    issue(500, { body: "", pull_request: {} }),
  ]) {
    const result = await readReportGithub({
      since,
      settings: githubReportFixture({
        readyIssues: [[issue(500)]],
        timelines: { 500: [[label("labeled", -5)]] },
        details: { 500: detail },
      }).settings,
    });
    assert.equal(result.ready, null);
    assert.equal(result.sources.ready.status, "unavailable");
  }
});
