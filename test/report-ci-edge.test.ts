import assert from "node:assert/strict";
import { test } from "node:test";
import { items } from "./service-fixture.ts";
import { ciJob, ciUsageReport, ciUsageScene } from "./report-ci-fixture.ts";

await test("CLV-246 started jobs contribute runner waits before completion and medians combine different waits", async () => {
  const result = await ciUsageReport(
    ciUsageScene({
      jobs: [
        ciJob(1, { started_at: "2026-10-24T10:02:00Z" }),
        ciJob(2),
        ciJob(3, {
          started_at: "2026-10-24T10:10:00Z",
          completed_at: null,
          conclusion: null,
        }),
        ciJob(4, { started_at: null, completed_at: null, conclusion: null }),
        ciJob(5, {
          started_at: null,
          completed_at: null,
          conclusion: "skipped",
        }),
      ],
    }),
  );
  assert.equal(result.ci.runnerWaitMinutes["localMacos"]?.value, 4);
  assert.equal(
    items(result.ci.runnerWaitMinutes["localMacos"].evidence).length,
    3,
  );
  assert.equal(result.ci.jobMinutes["localMacos"]?.value, 51);
});

await test("CLV-246 workflow names, matrix names and hosted image names resolve limits and runner systems", async () => {
  const result = await ciUsageReport(
    ciUsageScene({
      jobs: [
        ciJob(1, { name: "quality (node-26)", labels: [] }),
        ciJob(2, {
          name: "A named job",
          labels: ["self-hosted", "macOS"],
          runner_name: "macOS local",
        }),
        ciJob(3, { name: "unlimited", labels: ["self-hosted", "linux"] }),
      ],
      workflow: JSON.stringify({
        jobs: {
          quality: { "timeout-minutes": 75, "runs-on": "ubuntu-latest" },
          named: { name: "A named job", "timeout-minutes": 100 },
        },
      }),
    }),
  );
  assert.equal(result.ci.jobLimitShare["hostedLinux"]?.value, 50 / 75);
  assert.equal(result.ci.jobLimitShare["localMacos"]?.value, 0.5);
  assert.equal(result.ci.jobMinutes["localLinux"]?.value, 50);
  assert.equal(result.ci.jobLimitShare["localLinux"]?.value, null);
});

await test("CLV-246 malformed job metadata is unavailable while reruns remain readable", async () => {
  for (const change of [
    { labels: [3] },
    { labels: ["windows"] },
    { started_at: "2026-10-24T11:00:00Z" },
    { created_at: "2026-10-24T10:05:00Z" },
  ]) {
    const result = await ciUsageReport(
      ciUsageScene({ jobs: [ciJob(1, change)] }),
    );
    assert.equal(result.ci.jobMinutes["localMacos"]?.status, "unavailable");
    assert.equal(result.ci.reruns.value, 0);
  }
});

await test("CLV-246 missing workflow paths and unreadable contents preserve job duration", async () => {
  for (const options of [
    { run: { path: "" } },
    { response: { encoding: "none", content: "" } },
  ]) {
    const result = await ciUsageReport(ciUsageScene(options));
    assert.equal(result.ci.jobMinutes["localMacos"]?.value, 50);
    assert.equal(result.ci.jobLimitShare["localMacos"]?.value, null);
  }
  for (const workflow of [
    "{}",
    "[]",
    JSON.stringify({ jobs: { quality: { "timeout-minutes": "dynamic" } } }),
  ]) {
    const result = await ciUsageReport(ciUsageScene({ workflow }));
    assert.equal(result.ci.jobLimitShare["localMacos"]?.value, null);
    assert.equal(result.ci.jobMinutes["localMacos"]?.value, 50);
  }
});

await test("CLV-246 runner system labels take precedence over runner names and workflow expressions", async () => {
  const result = await ciUsageReport(
    ciUsageScene({
      jobs: [
        ciJob(1, {
          labels: ["self-hosted", "Linux"],
          runner_name: "formerly-macos",
        }),
      ],
      workflow: JSON.stringify({
        jobs: { quality: { "runs-on": "macos-15", "timeout-minutes": 75 } },
      }),
    }),
  );
  assert.equal(result.ci.jobMinutes["localLinux"]?.value, 50);
  assert.equal(result.ci.jobMinutes["localMacos"]?.value, null);
});

await test("CLV-246 workflow run paths with ref suffixes read limits from the run commit", async () => {
  const result = await ciUsageReport(
    ciUsageScene({
      run: { path: ".github/workflows/ci.yml@refs/heads/feature" },
    }),
  );
  assert.equal(result.ci.jobLimitShare["localMacos"]?.value, 50 / 75);
});

await test("CLV-246 a job ending exactly at its limit counts once as a timeout", async () => {
  const result = await ciUsageReport(
    ciUsageScene({
      jobs: [
        ciJob(1, {
          labels: ["ubuntu-latest"],
          completed_at: "2026-10-24T11:19:00Z",
        }),
      ],
    }),
  );
  assert.equal(result.ci.timeouts.value, 1);
  assert.equal(result.ci.jobLimitShare["hostedLinux"]?.value, 1);
  assert.deepEqual(
    result.ci.timeouts.evidence.map((item) => item["jobId"]),
    [1],
  );
});
