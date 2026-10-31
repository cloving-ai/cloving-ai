import assert from "node:assert/strict";
import { test } from "node:test";
import { readyTicketsOf } from "../src/cli/report-ready.ts";
import { readReportGithub } from "../src/cli/report-github.ts";
import { repositoryReader } from "../src/cli/report-github-reader.ts";
import {
  githubReportFixture,
  issue,
  output,
  since,
} from "./report-github-fixture.ts";

await test("CLV-244 ready discovery bounds concurrent timelines and visits old issues", async () => {
  const pending: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  const visited: string[] = [];
  const scan = readyTicketsOf({
    repository: {
      host: "github.example",
      owner: "fixture",
      repository: "demo",
    },
    read: async (endpoint) => {
      visited.push(endpoint);
      const listing = endpoint.startsWith("issues?");
      if (!listing) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active -= 1;
      }
      return listing
        ? Array.from({ length: 12 }, (_, index) => issue(index + 1))
        : [];
    },
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(active, 5);
  } finally {
    for (let batch = 0; batch < 12; batch += 1) {
      pending.splice(0).forEach((resolve) => {
        resolve();
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await scan;
  }
  assert.equal(peak, 5);
  assert.equal(
    visited.filter((endpoint) => endpoint.includes("/timeline?")).length,
    12,
  );
});

await test("CLV-244 lead time and ready discovery share timeline requests", async () => {
  const scene = githubReportFixture({
    issues: [[issue(500)]],
    readyIssues: [[issue(500)]],
    timelines: {
      500: [
        [
          {
            event: "labeled",
            created_at: since,
            label: { name: "cloving: ready" },
          },
        ],
      ],
    },
    details: { 500: issue(500, { body: "" }) },
  });
  const report = await readReportGithub({ since, settings: scene.settings });
  assert.equal(report.sources.timelines.status, "available");
  assert.equal(report.sources.ready.status, "available");
  assert.equal(report.ready?.length, 1);
  assert.equal(scene.timelineAttempts(), 1);
});

await test("CLV-244 each GitHub read has a fresh deadline across a long scan", async () => {
  const scene = githubReportFixture();
  const signals: AbortSignal[] = [];
  const reader = await repositoryReader({
    since,
    settings: {
      ...scene.settings,
      execute: async (request) => {
        signals.push(request.signal);
        return request.command[0] === "git"
          ? scene.settings.execute(request)
          : output([]);
      },
    },
  });
  await reader.read("issues/1/timeline?per_page=100&page=1");
  await reader.read("issues/2/timeline?per_page=100&page=1");
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 3);
});
