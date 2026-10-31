import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import { loopReport } from "../src/report.ts";
import { fields, items } from "./service-fixture.ts";
import {
  githubReportFixture as fixture,
  issue,
  since,
  output,
} from "./report-github-fixture.ts";
await test("CLV-243 lead time uses the last ready label before each completed close", async () => {
  const scene = fixture({
    issues: [[issue(1), issue(2)]],
    timelines: {
      1: [
        [
          {
            event: "labeled",
            label: { name: "cloving: ready" },
            created_at: "2026-10-22T06:00:00Z",
          },
          {
            event: "labeled",
            label: { name: "cloving: ready" },
            created_at: "2026-10-23T06:00:00Z",
          },
          {
            event: "labeled",
            label: { name: "cloving: ready" },
            created_at: "2026-10-24T13:00:00Z",
          },
        ],
      ],
      2: [
        [
          {
            event: "labeled",
            label: { name: "cloving: ready" },
            created_at: "2026-10-24T06:00:00Z",
          },
        ],
      ],
    },
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  const leads = fields(result)["leadTimes"];
  assert.deepEqual(
    items(leads).map((datum) => fields(datum)["value"]),
    [30, 6],
  );
  const metrics = fields(
    loopReport({
      now: Date.parse("2026-10-25T00:00:00Z"),
      since: 24,
      completions: [],
      github: result,
    })["metrics"],
  );
  const lead = fields(metrics["leadTime.medianHours"]);
  assert.equal(lead["value"], 18);
  assert.deepEqual(
    items(lead["evidence"]).map((datum) => fields(datum)["issue"]),
    [1, 2],
  );
});

await test("CLV-243 unreadable timelines retry and leave lead time unavailable while ticket counts remain readable", async () => {
  const failure = { ...output(null), status: 1, stderr: "HTTP 502 (HTTP 502)" };
  const scene = fixture({
    issues: [[issue(1)]],
    timelineFailures: [failure, failure, failure],
  });
  const result = await readReportGithub({
    since,
    settings: scene.settings,
    retryMilliseconds: 1,
  });
  assert.equal(result.leadTimes, null);
  assert.equal(result.sources.timelines.reason, "github-network-failed");
  assert.equal(scene.timelineAttempts(), 3);
  assert.equal(result.issues?.length, 1);
  const report = loopReport({
    now: Date.parse("2026-10-25T00:00:00Z"),
    since: 24,
    completions: [],
    github: result,
  });
  assert.equal(
    fields(fields(report["metrics"])["leadTime.medianHours"])["status"],
    "unavailable",
  );
});

await test("CLV-243 timeline pagination includes the latest label and refuses unreadable later pages", async () => {
  const first = Array.from({ length: 100 }, (_, id) => ({
    id,
    event: "commented",
  }));
  const latest = [
    {
      event: "labeled",
      label: { name: "cloving: ready" },
      created_at: "2026-10-24T06:00:00Z",
    },
  ];
  const scene = fixture({
    issues: [[issue(1)]],
    timelines: { 1: [first, latest] },
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.equal(result.leadTimes?.[0]?.value, 6);
  assert.equal(scene.timelineAttempts(), 2);
  for (const last of [first, null]) {
    const broken = await readReportGithub({
      since,
      settings: fixture({
        issues: [[issue(1)]],
        timelines: { 1: [first, last] },
      }).settings,
    });
    assert.equal(broken.leadTimes, null);
  }
});

await test("CLV-243 a missing ready label is unknown and an authentication refusal is not retried", async () => {
  const missing = await readReportGithub({
    since,
    settings: fixture({ issues: [[issue(1)]] }).settings,
  });
  assert.equal(missing.leadTimes?.[0]?.value, null);
  const scene = fixture({
    issues: [[issue(1)]],
    timelineFailures: [
      { ...output(null), status: 4, stderr: "authentication required" },
    ],
  });
  const denied = await readReportGithub({ since, settings: scene.settings });
  assert.equal(denied.leadTimes, null);
  assert.equal(scene.timelineAttempts(), 1);
});
