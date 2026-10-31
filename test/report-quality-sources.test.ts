import assert from "node:assert/strict";
import { test } from "node:test";
import { loopReport } from "../src/report.ts";
import { reportFailureData } from "../src/report-quality.ts";
import { readReportGithub } from "../src/cli/report-github.ts";
import { githubReportFixture, issue, since } from "./report-github-fixture.ts";
import { effectEvents } from "./report-fixture.ts";
import { fields } from "./service-fixture.ts";

const at = Date.parse("2026-10-24T12:00:00Z");
const now = Date.parse("2026-10-25T00:00:00Z");
const commit = "a".repeat(40);
const endpoint = `runs?branch=main&created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=1`;
const run = {
  id: 1,
  name: "CI",
  head_branch: "main",
  head_sha: commit,
  run_attempt: 1,
  conclusion: "success",
  created_at: new Date(at).toISOString(),
};
async function readQuality(options: Parameters<typeof githubReportFixture>[0]) {
  const fixture = githubReportFixture(options);
  const github = await readReportGithub({
    since,
    settings: fixture.settings,
    retryMilliseconds: 1,
  });
  return {
    github,
    fixture,
    report: loopReport({ since: 24, now, completions: [], github }),
  };
}

await test("CLV-245 a pass between failures proves flakiness and a remaining real failure", () => {
  const jobs = ["failure", "success", "failure"].map((conclusion, index) => ({
    id: index + 1,
    runId: 1,
    commit,
    name: "quality",
    attempt: index + 1,
    at: at + index,
    conclusion,
  }));
  const data = reportFailureData({
    jobs,
    names: { 1: ["flaky test"], 3: ["real test"] },
  });
  assert.equal(data.flaky.length, 1);
  assert.equal(data.real.length, 1);
  assert.deepEqual(data.flaky[0]?.evidence["testNames"], ["flaky test"]);
  assert.deepEqual(data.real[0]?.evidence["testNames"], ["real test"]);
});

await test("CLV-245 missing pull titles leave reversions unavailable while merge counts remain readable", async () => {
  const result = await readQuality({
    pulls: [
      {
        number: 2,
        html_url: "https://github.example/fixture/demo/pull/2",
        updated_at: new Date(at).toISOString(),
        merged_at: new Date(at).toISOString(),
      },
    ],
  });
  assert.equal(result.report.metrics["pullRequests.merged"].value, 1);
  assert.equal(
    fields(fields(fields(result.report)["quality"])["revertedPullRequests"])[
      "status"
    ],
    "unavailable",
  );
});

await test("CLV-245 a truncated GitHub run search is unavailable instead of a partial share", async () => {
  const result = await readQuality({
    actions: { [endpoint]: { total_count: 1001, workflow_runs: [run] } },
  });
  assert.equal(result.github.sources.ci.status, "unavailable");
  assert.equal(
    fields(fields(fields(result.report)["quality"])["mainFirstPassShare"])[
      "value"
    ],
    null,
  );
});

await test("CLV-245 first-attempt identity must match the commit", async () => {
  const result = await readQuality({
    actions: {
      [endpoint]: {
        total_count: 1,
        workflow_runs: [{ ...run, run_attempt: 2 }],
      },
      "runs/1/attempts/1": { ...run, head_sha: "b".repeat(40) },
    },
  });
  assert.equal(result.github.sources.ci.status, "unavailable");
});

await test("CLV-245 failed close reason reads leave ticket history unavailable without losing pull reads", async () => {
  const result = await readQuality({
    issues: [[issue(1)]],
    closures: {
      1: [
        [
          {
            event: "closed",
            node_id: "missing",
            created_at: new Date(at).toISOString(),
          },
        ],
      ],
    },
  });
  assert.equal(result.github.issues, null);
  assert.equal(result.github.sources.pulls.status, "available");
});

await test("CLV-245 an invalid review score leaves only its round unavailable", () => {
  const events = [
    ...effectEvents("review", {
      method: "wait-review",
      sequence: 1,
      at,
      result: { score: 99 },
    }),
    ...effectEvents("review", {
      method: "wait-review",
      sequence: 3,
      at,
      result: { score: 5 },
    }),
  ];
  const report = loopReport({
    since: 24,
    now,
    completions: [],
    effects: events,
  });
  const scores = fields(fields(fields(report)["quality"])["reviewScore"]);
  assert.equal(fields(scores["round1"])["status"], "unavailable");
  assert.equal(fields(scores["round2"])["value"], 5);
});

await test("CLV-245 repeated failures of one commit retain each daily baseline observation", () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    runId: index + 1,
    commit,
    name: "quality",
    attempt: 1,
    at: at - index * 86_400_000,
    conclusion: "failure",
  }));
  const failures = reportFailureData({ jobs, names: {} });
  const report = loopReport({
    since: 24,
    now,
    completions: [],
    github: { issues: [], pulls: [], sources: {}, observedSince: 0, failures },
  });
  const metric = fields(fields(fields(report)["quality"])["realFailures"]);
  assert.equal(metric["value"], 1);
  assert.equal(fields(metric["baseline"])["median"], 1);
  assert.deepEqual(fields(metric["baseline"])["band"], { low: 1, high: 1 });
  assert.equal(metric["mark"], undefined);
  assert.deepEqual(metric["evidence"], [
    {
      commit,
      jobName: "quality",
      testNames: ["unknown"],
      jobIds: [1],
      runIds: [1],
    },
  ]);
});

await test("CLV-245 main run pagination includes later CI runs and refuses repeated pages", async () => {
  const first = Array.from({ length: 100 }, (_, index) => ({
    ...run,
    id: index + 1,
    name: index < 2 ? "CI" : "Other",
    head_branch: index === 1 ? "feature" : "main",
  }));
  const secondEndpoint = endpoint.replace(/&page=1$/, "&page=2");
  const result = await readQuality({
    actions: {
      [endpoint]: { total_count: 101, workflow_runs: first },
      [secondEndpoint]: {
        total_count: 101,
        workflow_runs: [{ ...run, id: 101, conclusion: "failure" }],
      },
    },
  });
  assert.equal(
    fields(fields(fields(result.report)["quality"])["mainFirstPassShare"])[
      "value"
    ],
    0.5,
  );
  const repeated = await readQuality({
    actions: {
      [endpoint]: { workflow_runs: first },
      [secondEndpoint]: { workflow_runs: first },
    },
  });
  assert.equal(repeated.github.sources.ci.status, "unavailable");
});

await test("CLV-245 malformed CI identities and conclusions are unavailable", async () => {
  for (const invalid of [{ id: 0 }, { conclusion: false }]) {
    const result = await readQuality({
      actions: { [endpoint]: { workflow_runs: [{ ...run, ...invalid }] } },
    });
    assert.equal(result.github.sources.ci.status, "unavailable");
  }
});

await test("CLV-245 malformed job fields leave failure counts unavailable and CI share readable", async () => {
  const good = {
    id: 1,
    name: "quality",
    head_sha: commit,
    run_id: 1,
    completed_at: new Date(at).toISOString(),
    conclusion: "success",
  };
  for (const invalid of [
    { name: null },
    { head_sha: "b".repeat(40) },
    { run_id: 2 },
    { id: 0 },
    { conclusion: false },
  ]) {
    const result = await readQuality({
      actions: {
        [endpoint]: { workflow_runs: [run] },
        "runs/1/attempts/1/jobs?per_page=100&page=1": {
          jobs: [{ ...good, ...invalid }],
        },
      },
    });
    assert.equal(result.github.sources.jobs.status, "unavailable");
    assert.equal(
      fields(fields(fields(result.report)["quality"])["mainFirstPassShare"])[
        "value"
      ],
      1,
    );
  }
});

await test("CLV-245 duplicate jobs on later pages cannot produce partial failure counts", async () => {
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: "quality",
    head_sha: commit,
    run_id: 1,
    completed_at: new Date(at).toISOString(),
    conclusion: "failure",
  }));
  const result = await readQuality({
    actions: {
      [endpoint]: { workflow_runs: [run] },
      "runs/1/attempts/1/jobs?per_page=100&page=1": { jobs },
      "runs/1/attempts/1/jobs?per_page=100&page=2": { jobs: [jobs[0]] },
    },
  });
  assert.equal(result.github.failures, null);
  assert.equal(
    result.fixture.commands.filter((command) =>
      command.some((part) => part.endsWith("/logs")),
    ).length,
    0,
  );
});

await test("CLV-245 an unreadable job log retains the known failure as unknown", async () => {
  const job = {
    id: 1,
    name: "quality",
    head_sha: commit,
    run_id: 1,
    started_at: new Date(at).toISOString(),
    conclusion: "failure",
  };
  const result = await readQuality({
    actions: {
      [endpoint]: { workflow_runs: [run] },
      "runs/1/attempts/1/jobs?per_page=100&page=1": { jobs: [job] },
    },
    responses: {
      "repos/fixture/demo/actions/jobs/1/logs": {
        stdout: "",
        stderr: "authentication required",
        status: 4,
        errorCode: null,
      },
    },
  });
  const metric = fields(
    fields(fields(result.report)["quality"])["realFailures"],
  );
  assert.equal(metric["value"], 1);
  assert.deepEqual(metric["evidence"], [
    {
      commit,
      jobName: "quality",
      testNames: ["unknown"],
      jobIds: [1],
      runIds: [1],
    },
  ]);
});

await test("CLV-245 historical closure reasons use a read-only GraphQL POST query", async () => {
  const result = await readQuality({
    issues: [[issue(1)]],
    closures: {
      1: [
        [
          {
            event: "closed",
            node_id: "close",
            created_at: new Date(at).toISOString(),
          },
        ],
      ],
    },
    nodes: { close: { id: "close", stateReason: "COMPLETED" } },
  });
  const command = result.fixture.commands.find((parts) =>
    parts.includes("graphql"),
  );
  assert.ok(command);
  assert.equal(command[command.indexOf("--method") + 1], "POST");
  assert.ok(command.some((part) => part.startsWith("query=query{node(")));
  assert.equal(result.github.issues?.length, 1);
});
