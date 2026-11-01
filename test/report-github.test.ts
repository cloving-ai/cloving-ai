import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import {
  githubReportFixture as fixture,
  issue,
  since,
  output,
} from "./report-github-fixture.ts";
const pull = (
  number: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  number,
  html_url: `https://github.example/fixture/demo/pull/${String(number)}`,
  updated_at: "2026-10-24T12:00:00Z",
  merged_at: "2026-10-24T12:00:00Z",
  ...extra,
});

await test("CLV-199 GitHub reads validate repository identity and separate completed tickets from merged pull requests", async () => {
  const scene = fixture({
    issues: [
      [
        issue(1),
        issue(2, { state_reason: "not_planned" }),
        issue(3, { pull_request: {} }),
      ],
      [],
    ],
    pulls: [pull(4), pull(5, { merged_at: null })],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.equal(result.issues?.length, 1);
  assert.equal(result.pulls?.length, 1);
  assert.deepEqual(result.issues[0]?.evidence, { issue: 1 });
  assert.deepEqual(result.pulls[0]?.evidence, { pullRequest: 4 });
  assert.ok(
    scene.commands
      .slice(1)
      .every(
        (command) =>
          command.slice(0, 2).join(" ") === "fake-gh prefix" &&
          command.includes("GET") &&
          command.includes("github.example"),
      ),
  );
});

await test("CLV-199 large GitHub issue pages keep ticket counts and baseline evidence within the CLI output limit", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    issue(index + 1, { body: "x".repeat(65_536) }),
  );
  const scene = fixture({
    issues: [
      first,
      [
        issue(101, { closed_at: "2026-10-20T12:00:00Z" }),
        issue(102, { pull_request: {} }),
        issue(103, { state_reason: "not_planned" }),
      ],
    ],
    issueOutputLimit: 1024 * 1024,
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.equal(result.sources.issues.status, "available");
  assert.equal(result.issues?.length, 101);
  assert.deepEqual(result.issues.at(-1), {
    at: Date.parse("2026-10-20T12:00:00Z"),
    value: 1,
    evidence: { issue: 101 },
  });
  assert.equal(scene.attempts(), 2);
});

await test("CLV-199 an unreadable later issue page retries without reporting partial ticket counts", async () => {
  const first = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const failure = { ...output(null), status: 1, stderr: "HTTP 502 (HTTP 502)" };
  const scene = fixture({
    failures: [output(first), failure, failure, failure],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.equal(scene.attempts(), 4);
  assert.equal(result.issues, null);
  assert.equal(result.sources.issues.reason, "github-network-failed");
  assert.equal(result.sources.pulls.status, "available");
  const repeated = await readReportGithub({
    since,
    settings: fixture({ issues: [first, first] }).settings,
  });
  assert.equal(repeated.issues, null);
});

await test("CLV-199 transient GitHub reads use three attempts and keep other sources available", async () => {
  const failure = {
    stdout: "",
    stderr: "HTTP 502 (HTTP 502)",
    status: 1,
    errorCode: null,
  };
  const scene = fixture({ failures: [failure, failure, failure] });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: scene.settings,
  });
  assert.equal(scene.attempts(), 3);
  assert.equal(result.issues, null);
  assert.deepEqual(result.pulls, []);
  assert.equal(result.sources.issues.status, "unavailable");
  assert.equal(result.sources.issues.reason, "github-network-failed");
});

await test("CLV-199 invalid configuration and foreign response identities are unavailable", async () => {
  const malformed = await readReportGithub({
    since,
    settings: { ...fixture().settings, githubCommand: "[]" },
  });
  assert.equal(malformed.issues, null);
  const foreign = await readReportGithub({
    since,
    settings: fixture({
      issues: [
        [issue(1, { html_url: "https://other.example/owner/repo/issues/1" })],
      ],
    }).settings,
  });
  assert.equal(foreign.issues, null);
});

await test("CLV-199 a young repository has short history rather than seven invented days", async () => {
  const result = await readReportGithub({
    since,
    settings: fixture({ created: "2026-10-23T00:00:00Z" }).settings,
  });
  assert.equal(result.observedSince, Date.parse("2026-10-23T00:00:00Z"));
});

await test("CLV-199 repository creation identity is case insensitive", async () => {
  const result = await readReportGithub({
    since,
    settings: fixture({ repositoryName: "Fixture/Demo" }).settings,
  });
  assert.equal(result.sources.history.status, "available");
  assert.equal(result.observedSince, Date.parse("2026-01-01T00:00:00Z"));
});

await test("CLV-199 GitHub pagination reads later merges and rejects repeated pages", async () => {
  const first = Array.from({ length: 100 }, (_, index) => pull(index + 1));
  const scene = fixture({ pullPages: [first, [pull(101)]] });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.equal(result.pulls?.length, 101);
  const repeated = await readReportGithub({
    since,
    settings: fixture({ pullPages: [first, first] }).settings,
  });
  assert.equal(repeated.pulls, null);
});

await test("CLV-199 malformed GitHub sources remain unavailable and authentication errors are not retried", async () => {
  for (const issues of [
    "invalid",
    [null],
    [[null]],
    [[issue(1), issue(1)]],
    [[issue(1, { state_reason: null })]],
    [[issue(1, { closed_at: "bad" })]],
  ]) {
    const result = await readReportGithub({
      since,
      settings: fixture({ issues }).settings,
    });
    assert.equal(result.issues, null);
    assert.equal(result.sources.issues.status, "unavailable");
  }
  const scene = fixture({
    failures: [
      { ...output(null), status: 4, stderr: "authentication required" },
    ],
  });
  const denied = await readReportGithub({ since, settings: scene.settings });
  assert.equal(denied.issues, null);
  assert.equal(scene.attempts(), 1);
});

await test("CLV-199 one network failure retries a GET and then reports readable data", async () => {
  const scene = fixture({
    failures: [{ ...output(null), status: 1, stderr: "TLS handshake timeout" }],
  });
  const result = await readReportGithub({
    since,
    retryMilliseconds: 1,
    settings: { ...scene.settings, githubCommand: undefined },
  });
  assert.deepEqual(result.issues, []);
  assert.equal(scene.attempts(), 2);
  assert.ok(scene.commands.some((command) => command[0] === "gh"));
  for (const githubCommand of ["not json", '["fake-gh",0]', '[""]']) {
    const unavailable = await readReportGithub({
      since,
      settings: { ...scene.settings, githubCommand },
    });
    assert.equal(unavailable.issues, null);
  }
});

import { loopReport } from "../src/report.ts";
import { fields, items } from "./service-fixture.ts";

await test("CLV-245 ten main CI runs have a first-attempt pass share of 0.8", async () => {
  const runs = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    name: "CI",
    head_branch: "main",
    head_sha: String(index).repeat(40),
    run_attempt: index < 8 ? 1 : 2,
    conclusion: index === 9 ? "failure" : "success",
    created_at: "2026-10-24T12:00:00Z",
  }));
  const scene = fixture({
    actions: {
      "runs/9/attempts/1": {
        ...runs[8],
        run_attempt: 1,
        conclusion: "failure",
      },
      "runs/10/attempts/1": {
        ...runs[9],
        run_attempt: 1,
        conclusion: "failure",
      },
      [`runs?branch=main&created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=1`]:
        { workflow_runs: runs, total_count: 10 },
    },
  });
  const github = await readReportGithub({ since, settings: scene.settings });
  const report = loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    github,
  });
  const quality = fields(
    fields(report)["quality"] ?? fields(report.coverage)["quality"],
  );
  assert.equal(quality["reason"], undefined);
  assert.equal(fields(quality["mainFirstPassShare"])["value"], 0.8);
});

function recentJobScene() {
  const at = "2026-10-24T12:00:00Z";
  const older = "2026-10-01T00:00:00Z";
  const runs = [1, 2, 3].map((id) => ({
    id,
    name: "CI",
    head_branch: "main",
    head_sha: (id === 1 ? "a" : "b").repeat(40),
    run_attempt: id === 3 ? 2 : 1,
    conclusion: id === 3 ? "success" : "failure",
    created_at: id === 2 ? at : older,
    updated_at: at,
  }));
  const jobs = Object.fromEntries(
    runs.flatMap((run) =>
      Array.from({ length: run.run_attempt }, (_, index) => [
        `runs/${String(run.id)}/attempts/${String(index + 1)}/jobs?per_page=100&page=1`,
        {
          jobs: [
            {
              id: run.id * 10 + index,
              run_id: run.id,
              head_sha: run.head_sha,
              name: "quality",
              conclusion: index === 1 ? "success" : "failure",
              completed_at:
                run.id === 3 ? [older, "2026-10-24T13:00:00Z"][index] : at,
            },
          ],
        },
      ]),
    ),
  );
  return fixture({
    actions: {
      ...jobs,
      [`runs?branch=main&created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=1`]:
        { workflow_runs: [runs[1]], total_count: 1 },
      "runs?per_page=100&page=1": {
        workflow_runs: Array.from({ length: 100 }, (_, index) => ({
          ...runs[0],
          id: index + 100,
          updated_at: older,
        })),
        total_count: 1100,
      },
      "runs?per_page=100&page=2": { workflow_runs: runs, total_count: 1100 },
    },
  });
}

await test("CLV-245 recent jobs from older runs count failures and successful reruns without changing first pass", async () => {
  const scene = recentJobScene();
  const github = await readReportGithub({ since, settings: scene.settings });
  const report = loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    github,
  });
  const quality = fields(fields(report)["quality"]);
  const real = fields(quality["realFailures"]);
  const flaky = fields(quality["flakyFailures"]);
  assert.equal(real["value"], 1);
  assert.equal(fields(items(real["evidence"])[0])["commit"], "a".repeat(40));
  assert.deepEqual(fields(items(real["evidence"])[0])["jobIds"], [10]);
  assert.equal(flaky["value"], 1);
  assert.deepEqual(fields(items(flaky["evidence"])[0])["jobIds"], [20, 31]);
  assert.equal(fields(quality["mainFirstPassShare"])["value"], 0);
  assert.deepEqual(
    items(fields(quality["mainFirstPassShare"])["evidence"]).map(
      (evidence) => fields(evidence)["runId"],
    ),
    [2],
  );
  assert.equal(fields(quality["jobLogs"])["read"], 3);
});

await test("CLV-245 unreadable or invalid run activity leaves only job metrics unavailable", async () => {
  const endpoint = "runs?per_page=100&page=1";
  const runs = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  const cases = [
    {
      responses: {
        [`repos/fixture/demo/actions/${endpoint}`]: {
          ...output(null),
          status: 4,
          stderr: "authentication required",
        },
      },
    },
    {
      actions: {
        [endpoint]: { workflow_runs: runs },
        "runs?per_page=100&page=2": { workflow_runs: runs },
      },
    },
    {
      actions: {
        [endpoint]: {
          workflow_runs: [
            {
              id: 1,
              name: "CI",
              head_branch: "main",
              updated_at: "invalid",
            },
          ],
        },
      },
    },
  ];
  for (const options of cases) {
    const scene = fixture(options);
    const github = await readReportGithub({ since, settings: scene.settings });
    assert.equal(github.sources.jobs.status, "unavailable");
    assert.equal(github.sources.ci.status, "available");
    assert.equal(github.sources.pulls.status, "available");
    assert.equal(github.failures, null);
    assert.equal(github.jobLogs, null);
  }
});
