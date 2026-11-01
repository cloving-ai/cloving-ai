import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import { githubReportFixture, output } from "./report-github-fixture.ts";
import {
  ciCommit,
  ciJob,
  ciRun,
  ciUsageReport,
  workflowResponse,
} from "./report-ci-fixture.ts";

function scene(
  options: { readonly workflow?: string; readonly failure?: string } = {},
) {
  const workflow = JSON.stringify({
    jobs: { quality: { "timeout-minutes": 75 } },
  });
  const kinds = [
    ["self-hosted", "macOS"],
    ["self-hosted", "Linux"],
    ["macos-15"],
    ["ubuntu-24.04"],
  ];
  const jobs = kinds.map((labels, index) =>
    ciJob(index + 1, {
      labels,
      completed_at: `2026-10-24T${String(10 + index).padStart(2, "0")}:54:00Z`,
    }),
  );
  const responses = {
    [`repos/fixture/demo/contents/.github/workflows/ci.yml?ref=${ciCommit}`]:
      workflowResponse(options.workflow ?? workflow),
    ...(options.failure === undefined
      ? {}
      : {
          [options.failure]: {
            ...output(null),
            status: 4,
            stderr: "authentication required",
          },
        }),
  };
  return githubReportFixture({
    actions: {
      "runs?per_page=100&page=1": {
        workflow_runs: [
          ciRun(246, { run_attempt: 2 }),
          ciRun(247, { run_attempt: 2 }),
        ],
      },
      "runs/246/attempts/1/jobs?per_page=100&page=1": { jobs },
      "runs/246/attempts/2/jobs?per_page=100&page=1": {
        jobs: [ciJob(5, { conclusion: "timed_out" })],
      },
      "runs/247/attempts/1/jobs?per_page=100&page=1": { jobs: [] },
      "runs/247/attempts/2/jobs?per_page=100&page=1": { jobs: [] },
    },
    responses,
  });
}

await test("CLV-246 all runner kinds expose median shares, durations and waits across all attempts", async () => {
  const report = await ciUsageReport(scene());
  const ci = fields(report)["ci"];
  for (const [index, kind] of [
    "localMacos",
    "localLinux",
    "hostedMacos",
    "hostedLinux",
  ].entries()) {
    assert.equal(
      fields(fields(fields(ci)["jobLimitShare"])[kind])["value"],
      (50 + index * 60) / 75,
    );
    assert.equal(
      fields(fields(fields(ci)["runnerWaitMinutes"])[kind])["value"],
      4,
    );
    assert.equal(
      fields(fields(fields(ci)["jobMinutes"])[kind])["value"],
      50 + index * 60,
    );
  }
  assert.equal(fields(fields(ci)["timeouts"])["value"], 4);
  assert.deepEqual(
    items(fields(fields(ci)["timeouts"])["evidence"]).map(
      (item) => fields(item)["jobId"],
    ),
    [2, 3, 4, 5],
  );
  assert.equal(fields(fields(ci)["reruns"])["value"], 2);
  assert.deepEqual(
    items(fields(fields(ci)["reruns"])["evidence"]).map(
      (item) => fields(item)["runId"],
    ),
    [246, 247],
  );
});

await test("CLV-246 non-JSON workflow files keep job time and waits without shares", async () => {
  const ci = fields(
    fields(
      await ciUsageReport(
        scene({ workflow: "jobs:\n  quality:\n    timeout-minutes: 75" }),
      ),
    )["ci"],
  );
  assert.equal(fields(fields(ci["jobMinutes"])["localMacos"])["value"], 50);
  assert.equal(
    fields(fields(ci["jobLimitShare"])["localMacos"])["value"],
    null,
  );
  assert.equal(fields(ci["timeouts"])["value"], 1);
});

await test("CLV-246 unreadable workflow limits preserve independent job and rerun values", async () => {
  const ci = fields(
    fields(
      await ciUsageReport(
        scene({
          failure: `repos/fixture/demo/contents/.github/workflows/ci.yml?ref=${ciCommit}`,
        }),
      ),
    )["ci"],
  );
  assert.equal(fields(fields(ci["jobMinutes"])["localMacos"])["value"], 50);
  assert.equal(
    fields(fields(ci["runnerWaitMinutes"])["localMacos"])["value"],
    4,
  );
  assert.equal(
    fields(fields(ci["jobLimitShare"])["localMacos"])["status"],
    "unavailable",
  );
  assert.equal(fields(ci["timeouts"])["value"], null);
  assert.equal(fields(ci["reruns"])["value"], 2);
});

await test("CLV-246 unreadable jobs preserve reruns and unreadable runs do not become zero", async () => {
  for (const failure of [
    "repos/fixture/demo/actions/runs/246/attempts/1/jobs?per_page=100&page=1",
    "repos/fixture/demo/actions/runs?per_page=100&page=1",
  ]) {
    const ci = fields(fields(await ciUsageReport(scene({ failure })))["ci"]);
    assert.equal(
      fields(fields(ci["runnerWaitMinutes"])["localMacos"])["value"],
      null,
    );
    assert.equal(fields(ci["timeouts"])["status"], "unavailable");
    assert.equal(
      fields(ci["reruns"])["value"],
      failure.includes("/jobs?") ? 2 : null,
    );
  }
});

await test("CLV-246 CI usage sources expose feature-branch run, job and workflow read failures", async () => {
  const paths = {
    ciUsage: "repos/fixture/demo/actions/runs?per_page=100&page=1",
    ciUsageJobs:
      "repos/fixture/demo/actions/runs/246/attempts/1/jobs?per_page=100&page=1",
    ciUsageWorkflows: `repos/fixture/demo/contents/.github/workflows/ci.yml?ref=${ciCommit}`,
  };
  for (const [failed, failure] of Object.entries(paths)) {
    const report = await ciUsageReport(scene({ failure }));
    const sources = report.sources.github;
    assert.equal(fields(sources[failed])["status"], "unavailable");
    assert.equal(fields(sources[failed])["reason"], "read-failed");
    assert.equal(fields(sources["ci"])["status"], "available");
    for (const name of Object.keys(paths)) {
      const status =
        failed === "ciUsage" || name === failed ? "unavailable" : "available";
      assert.equal(fields(sources[name])["status"], status);
    }
  }
});

await test("CLV-246 empty CI usage reads expose available sources without job samples", async () => {
  const report = await ciUsageReport(githubReportFixture());
  for (const name of ["ciUsage", "ciUsageJobs", "ciUsageWorkflows"])
    assert.deepEqual(report.sources.github[name], { status: "available" });
  assert.equal(report.ci.reruns.value, 0);
  assert.equal(report.ci.jobMinutes["localMacos"]?.value, null);
});
