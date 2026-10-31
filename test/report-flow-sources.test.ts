import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportFlow } from "../src/cli/report-flow.ts";
import { items } from "./service-fixture.ts";
import { reportReply, withReportSource } from "./report-fixture.ts";

const started = {
  type: "run.started",
  runId: "run",
  recordedAt: "2026-10-24T00:00:00Z",
};

await test("CLV-244 flow batches relevant workflow identities and skips runs ended before baseline", async () => {
  const runs = [
    "old",
    "crossing",
    ...Array.from({ length: 500 }, (_, index) => `run-${String(index)}`),
  ];
  await withReportSource(
    (request) => ({
      kind: "result",
      result:
        request.parameters["metadata"] === "workflows"
          ? {
              runs: items(request.parameters["runIds"]).map((runId) => ({
                runId,
                workflowId: "queue",
              })),
            }
          : { queue: { workflowId: "queue", lanes: 2 } },
    }),
    async (harness, requests) => {
      const result = await readReportFlow(harness.runtimeDirectory, {
        start: 1000,
        events: runs.map((runId) => ({
          type: "run.started",
          runId,
          recordedAt: new Date(0).toISOString(),
        })),
        completions: [
          { runId: "old", at: 1000, sequence: 1, outcome: "completed" },
          { runId: "crossing", at: 1001, sequence: 2, outcome: "completed" },
        ],
      });
      const batches = requests.filter(
        (request) => request.parameters["metadata"] === "workflows",
      );
      assert.equal(batches.length, 2);
      assert.equal(requests.length, 3);
      assert.deepEqual(
        batches.map((request) => items(request.parameters["runIds"]).length),
        [500, 1],
      );
      assert.deepEqual(
        result.runs?.map((run) => run.runId),
        runs.slice(1),
      );
      assert.ok(result.runs.every((run) => run.workflowId === "queue"));
    },
  );
});

await test("CLV-244 malformed schedule data is unavailable without hiding readable run data", async () => {
  await withReportSource(
    reportReply([], [{ runId: "run", workflowId: "queue" }]),
    async (harness) => {
      const result = await readReportFlow(harness.runtimeDirectory, {
        start: 0,
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
        start: 0,
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
            start: 0,
            completions: null,
            events: null,
          })
        ).runs,
        null,
      );
    },
  );
});

await test("CLV-244 malformed identity batches leave workflow identity unknown", async () => {
  for (const runs of [
    undefined,
    [],
    [null],
    [{ runId: "other", workflowId: "queue" }],
    [{ runId: "run", workflowId: "" }],
  ]) {
    await withReportSource(
      () => ({ kind: "result", result: { runs } }),
      async (harness) => {
        const result = await readReportFlow(harness.runtimeDirectory, {
          start: 0,
          events: [started],
          completions: [],
        });
        assert.equal(result.runs?.[0]?.workflowId, null);
      },
    );
  }
});

await test("CLV-244 daemon flow reads workflow skips and rejects invalid run intervals", async () => {
  await withReportSource(
    (request) =>
      request.parameters["metadata"] === undefined &&
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
        start: 0,
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
              start: 0,
              completions: [],
              events,
            })
          ).runs,
          null,
        );
      const reversed = await readReportFlow(harness.runtimeDirectory, {
        start: 0,
        events: [started],
        completions: [{ runId: "run", at: 0, sequence: 1, outcome: "failed" }],
      });
      assert.equal(reversed.runs, null);
    },
  );
});
