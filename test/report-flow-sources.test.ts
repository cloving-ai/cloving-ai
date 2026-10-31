import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportFlow } from "../src/cli/report-flow.ts";
import { reportReply, withReportSource } from "./report-fixture.ts";

await test("CLV-244 malformed schedule data is unavailable without hiding readable run data", async () => {
  await withReportSource(
    reportReply([], [{ runId: "run", workflowId: "queue" }]),
    async (harness) => {
      const result = await readReportFlow(harness.runtimeDirectory, {
        completions: [],
        events: [
          {
            type: "run.started",
            runId: "run",
            recordedAt: "2026-10-24T00:00:00Z",
          },
          {
            type: "schedule.skipped",
            sequence: 2,
            recordedAt: "2026-10-24T01:00:00Z",
            payload: {},
          },
        ],
      });
      assert.equal(result.skips, null);
      assert.equal(result.runs?.length, 1);
    },
  );
});

await test("CLV-244 queue and run identity failures do not turn active runs into zero busy time", async () => {
  await withReportSource(
    () => ({
      kind: "error",
      error: { code: "unavailable", detail: "Unavailable" },
    }),
    async (harness) => {
      const result = await readReportFlow(harness.runtimeDirectory, {
        completions: [],
        events: [
          {
            type: "run.started",
            runId: "run",
            recordedAt: "2026-10-24T00:00:00Z",
          },
        ],
      });
      assert.equal(result.queue, null);
      assert.equal(result.runs?.[0]?.workflowId, null);
      assert.deepEqual(result.skips, []);
      assert.equal(
        (
          await readReportFlow(harness.runtimeDirectory, {
            completions: null,
            events: null,
          })
        ).runs,
        null,
      );
    },
  );
});

await test("CLV-244 daemon flow reads workflow skips and rejects invalid run intervals", async () => {
  const started = {
    type: "run.started",
    runId: "run",
    recordedAt: "2026-10-24T00:00:00Z",
  };
  await withReportSource(
    (request) =>
      request.parameters["runId"] === undefined
        ? {
            kind: "result",
            result: {
              queue: { workflowId: "queue", lanes: 2 },
              workflows: ["queue", "other"],
            },
          }
        : reportReply([], [{ runId: "run", workflowId: "queue" }])(request),
    async (harness) => {
      const result = await readReportFlow(harness.runtimeDirectory, {
        completions: [],
        events: [
          started,
          {
            type: "schedule.skipped",
            sequence: 2,
            recordedAt: "2026-10-24T01:00:00Z",
            payload: { workflowId: "other" },
          },
        ],
      });
      assert.deepEqual(result.workflows, ["queue", "other"]);
      assert.deepEqual(result.skips, [
        {
          workflowId: "other",
          at: Date.parse("2026-10-24T01:00:00Z"),
          sequence: 2,
        },
      ]);
      for (const events of [
        [started, started],
        [{ ...started, runId: 1 }],
        [{ ...started, recordedAt: "bad" }],
      ])
        assert.equal(
          (
            await readReportFlow(harness.runtimeDirectory, {
              completions: [],
              events,
            })
          ).runs,
          null,
        );
      const reversed = await readReportFlow(harness.runtimeDirectory, {
        events: [started],
        completions: [{ runId: "run", at: 0, sequence: 1, outcome: "failed" }],
      });
      assert.equal(reversed.runs, null);
    },
  );
});
