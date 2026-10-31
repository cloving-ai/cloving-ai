import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import { loopReport } from "../src/report.ts";
import { githubReportFixture, since } from "./report-github-fixture.ts";
import { fields, items } from "./service-fixture.ts";

const at = "2026-10-24T12:00:00Z";
const commit = "a".repeat(40);
const run = {
  id: 1,
  name: "CI",
  head_branch: "main",
  head_sha: commit,
  run_attempt: 2,
  conclusion: "success",
  created_at: at,
  updated_at: at,
};
const job = (
  id: number,
  result: { readonly name: string; readonly conclusion: string },
) => ({
  id,
  ...result,
  run_id: 1,
  head_sha: commit,
  started_at: at,
  completed_at: at,
});
const endpoint = `runs?branch=main&created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=1`;
function scene(
  options: {
    readonly failed?: readonly unknown[];
    readonly logs?: Readonly<Record<string, string>>;
  } = {},
) {
  return githubReportFixture({
    actions: {
      [endpoint]: { workflow_runs: [run], total_count: 1 },
      "runs?per_page=100&page=1": { workflow_runs: [run], total_count: 1 },
      "runs/1/attempts/1": { ...run, run_attempt: 1, conclusion: "failure" },
      "runs/1/attempts/1/jobs?per_page=100&page=1": {
        jobs: options.failed ?? [
          job(11, { name: "quality", conclusion: "failure" }),
          job(12, { name: "linux", conclusion: "failure" }),
        ],
      },
      "runs/1/attempts/2/jobs?per_page=100&page=1": {
        jobs: [
          job(21, { name: "quality", conclusion: "success" }),
          job(22, { name: "linux", conclusion: "failure" }),
        ],
      },
    },
    logs: options.logs ?? {
      "repos/fixture/demo/actions/jobs/11/logs":
        "2026-10-24T12:00:00Z Failed tests:\n2026-10-24T12:00:00Z CLV-053 delivery burst keeps the timer gap\n2026-10-24T12:00:00Z   expected gap\n",
    },
  });
}
async function quality(fixture: ReturnType<typeof scene>) {
  const github = await readReportGithub({ since, settings: fixture.settings });
  const report = loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    github,
  });
  return fields(fields(report)["quality"]);
}

await test("CLV-245 fail then pass is flaky and fail twice is one real failure with unknown names", async () => {
  const result = await quality(scene());
  const flaky = fields(result["flakyFailures"]);
  const real = fields(result["realFailures"]);
  assert.equal(flaky["value"], 1);
  assert.equal(real["value"], 1);
  const evidence = fields(items(flaky["evidence"])[0]);
  assert.equal(evidence["commit"], commit);
  assert.deepEqual(evidence["testNames"], [
    "CLV-053 delivery burst keeps the timer gap",
  ]);
  assert.deepEqual(evidence["jobIds"], [11, 21]);
  assert.deepEqual(fields(items(real["evidence"])[0])["testNames"], [
    "unknown",
  ]);
  assert.deepEqual(fields(items(real["evidence"])[0])["jobIds"], [12, 22]);
});

await test("CLV-245 a report reads at most fifty failed logs and exposes the unread count", async () => {
  const fixture = scene({
    failed: Array.from({ length: 53 }, (_, index) =>
      job(100 + index, { name: `job-${String(index)}`, conclusion: "failure" }),
    ),
  });
  const result = await quality(fixture);
  assert.equal(
    fixture.commands.filter((command) =>
      command.some((part) => part.endsWith("/logs")),
    ).length,
    50,
  );
  assert.equal(fields(result["jobLogs"])["notRead"], 4);
  assert.equal(fields(result["realFailures"])["value"], 54);
});

await test("CLV-245 job log reads stop at two MB and do not use names after the limit", async () => {
  const fixture = scene({
    logs: {
      "repos/fixture/demo/actions/jobs/11/logs":
        " ".repeat(2 * 1024 * 1024) + "\nFailed tests:\nhidden name\n",
    },
  });
  const result = await quality(fixture);
  assert.deepEqual(
    fields(items(fields(result["flakyFailures"])["evidence"])[0])["testNames"],
    ["unknown"],
  );
});

import { issue } from "./report-github-fixture.ts";
await test("CLV-245 completed close events count after reopen and revert titles count only merged pulls", async () => {
  const fixture = githubReportFixture({
    issues: [
      [issue(1, { state: "open", state_reason: "reopened", closed_at: null })],
    ],
    closures: {
      1: [
        [
          {
            id: 31,
            event: "closed",
            state_reason: "completed",
            created_at: at,
          },
          { id: 32, event: "reopened", created_at: "2026-10-24T13:00:00Z" },
        ],
      ],
    },
    pulls: [
      {
        number: 2,
        title: 'Revert "change"',
        html_url: "https://github.example/fixture/demo/pull/2",
        updated_at: at,
        merged_at: at,
      },
    ],
  });
  const github = await readReportGithub({ since, settings: fixture.settings });
  const report = loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    github,
  });
  const result = fields(fields(report)["quality"]);
  assert.equal(fields(report.metrics["tickets.completed"])["value"], 1);
  assert.equal(report.semantics.tickets, "closed-completed-in-window");
  assert.equal(fields(result["reopenedTickets"])["value"], 1);
  assert.equal(fields(result["revertedPullRequests"])["value"], 1);
  assert.equal(fields(report.coverage)["ticketClosureHistory"], undefined);
});

import { effectEvents } from "./report-fixture.ts";
await test("CLV-245 review scores have a median for each request round with run evidence", () => {
  const start = Date.parse(at);
  const events = [4, 5, 5].flatMap((score, index) => [
    ...effectEvents(`review-${String(index)}`, {
      method: "wait-review",
      sequence: index * 4 + 1,
      at: start,
      result: { score },
    }),
    ...effectEvents(`review-${String(index)}`, {
      method: "wait-review",
      sequence: index * 4 + 3,
      at: start + 60_000,
      result: { score: index + 2 },
    }),
  ]);
  const result = fields(
    fields(
      loopReport({
        since: 24,
        now: Date.parse("2026-10-25T00:00:00Z"),
        completions: [],
        effects: events,
      }),
    )["quality"],
  );
  const scores = fields(result["reviewScore"]);
  assert.equal(fields(scores["round1"])["value"], 5);
  assert.equal(fields(scores["round2"])["value"], 3);
  assert.deepEqual(
    items(fields(scores["round1"])["evidence"]).map(
      (item) => fields(item)["runId"],
    ),
    ["review-0", "review-1", "review-2"],
  );
});

await test("CLV-245 missing REST close reasons come from the immutable GraphQL close event", async () => {
  const fixture = githubReportFixture({
    issues: [[issue(1)]],
    closures: {
      1: [
        [
          {
            id: 31,
            node_id: "closed-event",
            event: "closed",
            state_reason: null,
            created_at: at,
          },
        ],
      ],
    },
    nodes: { "closed-event": { id: "closed-event", stateReason: "COMPLETED" } },
  });
  const github = await readReportGithub({ since, settings: fixture.settings });
  assert.equal(github.issues?.length, 1);
  assert.ok(fixture.commands.some((command) => command.includes("graphql")));
});

await test("CLV-245 source failures leave independent quality values readable", async () => {
  const base = scene();
  const settings = githubReportFixture({
    responses: {
      "repos/fixture/demo/actions/runs/1/attempts/1/jobs?per_page=100&page=1": {
        stdout: "",
        stderr: "authentication required",
        status: 4,
        errorCode: null,
      },
    },
  }).settings;
  const failedSettings = {
    ...base.settings,
    execute: sourceFailureRunner(base.settings.execute, settings.execute),
  };
  const github = await readReportGithub({
    since,
    settings: failedSettings,
    retryMilliseconds: 1,
  });
  const report = loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    github,
    effects: effectEvents("review", {
      method: "wait-review",
      sequence: 1,
      at: Date.parse(at),
      result: { score: 4 },
    }),
  });
  const result = fields(fields(report)["quality"]);
  assert.equal(fields(result["flakyFailures"])["status"], "unavailable");
  assert.equal(fields(result["realFailures"])["value"], null);
  assert.equal(fields(result["mainFirstPassShare"])["value"], 0);
  assert.equal(fields(result["revertedPullRequests"])["value"], 0);
  assert.equal(fields(fields(result["reviewScore"])["round1"])["value"], 4);
});

await test("CLV-245 quality uses seven daily baselines with bands, marks and evidence", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const start = now - 86_400_000;
  const mainFirstPass = Array.from({ length: 7 }, (_, index) => ({
    at: start - (index + 0.5) * 86_400_000,
    value: 1,
    evidence: { runId: index },
  }));
  const report = loopReport({
    since: 24,
    now,
    completions: [],
    github: {
      issues: [],
      pulls: [],
      sources: {},
      observedSince: 0,
      mainFirstPass: [
        ...mainFirstPass,
        { at: start + 1, value: 0, evidence: { runId: "current" } },
      ],
      failures: { flaky: [], real: [] },
      reopened: [],
      reverts: [],
    },
  });
  const metric = fields(
    fields(fields(report)["quality"])["mainFirstPassShare"],
  );
  assert.equal(metric["value"], 0);
  assert.equal(fields(metric["baseline"])["median"], 1);
  assert.deepEqual(fields(metric["baseline"])["band"], { low: 1, high: 1 });
  assert.equal(metric["mark"], "outside");
  assert.equal(items(fields(metric["baseline"])["evidence"]).length, 7);
});

function sourceFailureRunner(
  normal: ReturnType<typeof scene>["settings"]["execute"],
  failed: ReturnType<typeof scene>["settings"]["execute"],
) {
  return (request: Parameters<typeof normal>[0]) =>
    request.command.some((part) => part.includes("/attempts/1/jobs?"))
      ? failed(request)
      : normal(request);
}

await test("CLV-245 failed test names can start with Error or braces and exclude log footers", async () => {
  const fixture = scene({
    logs: {
      "repos/fixture/demo/actions/jobs/11/logs":
        "Failed tests:\nError: response is preserved\n  mismatch\n{key} is serialized\n  mismatch\n\nfooter text\n",
    },
  });
  const result = await quality(fixture);
  const evidence = items(fields(result["flakyFailures"])["evidence"]);
  assert.deepEqual(fields(evidence[0])["testNames"], [
    "Error: response is preserved",
    "{key} is serialized",
  ]);
});
