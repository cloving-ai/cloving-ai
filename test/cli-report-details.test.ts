import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items, parsed } from "./service-fixture.ts";
import {
  withReportSource,
  reportReply,
  endedEvent,
  configuredReportCli,
  phaseEvents,
} from "./report-fixture.ts";

await test("CLV-243 ticket metadata pagination finds an older attempt after the first page", async () => {
  const now = Date.now();
  const older = new Date(now - 20 * 86_400_000).toISOString();
  const recent = new Date(now - 1_800_000).toISOString();
  const runs = [
    ...Array.from({ length: 500 }, (_, index) => ({
      runId: `old-${String(index).padStart(3, "0")}`,
      ticketId: "8",
      costUsd: null,
    })),
    { runId: "z-partial", ticketId: "7", costUsd: 4.1 },
    { runId: "done", ticketId: "7", costUsd: 2.5 },
  ].map((run) => ({
    ...run,
    condition: "completed",
    effects: [],
    workerTurns: [{ operationId: `${run.runId}-turn`, costUsd: run.costUsd }],
  }));
  const events = runs.map((run, index) =>
    endedEvent(run.runId, {
      outcome: "completed",
      at: run.runId === "done" ? recent : older,
      sequence: index + 1,
    }),
  );
  await withReportSource(
    reportReply(events, runs),
    async (harness, requests) => {
      const output = await configuredReportCli(harness, ["--json"]);
      const report: unknown = JSON.parse(output.stdout);
      assert.equal(
        fields(items(fields(report)["completedTicketCosts"])[0])["costUsd"],
        6.6,
      );
      assert.deepEqual(
        requests
          .filter((request) => request.parameters["metadata"] === "tickets")
          .map((request) => request.parameters["after"]),
        ["", "old-498"],
      );
      assert.deepEqual(
        requests
          .filter((request) => request.parameters["runId"] !== undefined)
          .map((request) => request.parameters["runId"]),
        ["done", "z-partial"],
      );
    },
  );
});

await test("CLV-243 unreadable ticket metadata keeps ticket costs unavailable and recent run costs readable", async () => {
  const now = Date.now();
  const events = [-20 * 86_400_000, -1_800_000].map((offset, index) =>
    endedEvent(`run-${String(index)}`, {
      outcome: "completed",
      at: new Date(now + offset).toISOString(),
      sequence: index + 1,
    }),
  );
  const reply = reportReply(events, [
    {
      runId: "run-1",
      ticketId: "7",
      condition: "completed",
      effects: [],
      workerTurns: [{ operationId: "turn", costUsd: 2.5 }],
    },
  ]);
  for (const result of [
    { runs: null, next: null },
    { runs: [{ runId: "run-0" }], next: null },
    { runs: [], next: "" },
    { runs: [], next: null },
  ]) {
    await withReportSource(
      (request) =>
        request.parameters["metadata"] === "tickets"
          ? { kind: "result", result }
          : reply(request),
      async (harness) => {
        const output = await configuredReportCli(harness, ["--json"]);
        const report: unknown = JSON.parse(output.stdout);
        const metrics = fields(fields(report)["metrics"]);
        assert.equal(
          fields(metrics["cost.medianCompletedTicketUsd"])["status"],
          "unavailable",
        );
        assert.equal(
          fields(items(fields(report)["completedTicketCosts"])[0])["costUsd"],
          null,
        );
        assert.equal(fields(metrics["cost.medianRunUsd"])["value"], 2.5);
      },
    );
  }
});

await test("CLV-243 ticket metadata limits historical cost reads to relevant completed tickets", async () => {
  const now = Date.now();
  const runs = [
    { runId: "partial", ticketId: "7", costUsd: 4.1 },
    { runId: "unrelated", ticketId: "8", costUsd: null },
    { runId: "done", ticketId: "7", costUsd: 2.5 },
    { runId: "later", ticketId: "7", costUsd: null },
  ].map((run) => ({
    ...run,
    condition: "completed",
    effects: [],
    workerTurns: [{ operationId: `${run.runId}-turn`, costUsd: run.costUsd }],
  }));
  const events = runs.map((run, index) =>
    endedEvent(run.runId, {
      outcome: "completed",
      at: new Date(
        now +
          (index < 2 ? -20 * 86_400_000 : (index - 2) * 7_200_000 - 1_800_000),
      ).toISOString(),
      sequence: index + 1,
    }),
  );
  await withReportSource(
    reportReply(events, runs),
    async (harness, requests) => {
      const output = await configuredReportCli(harness, ["--json"]);
      const report: unknown = JSON.parse(output.stdout);
      assert.deepEqual(
        requests
          .filter(
            (request) =>
              request.operation === "status" &&
              request.parameters["runId"] !== undefined,
          )
          .map((request) => request.parameters["runId"]),
        ["done", "partial"],
      );
      assert.equal(
        requests.filter(
          (request) => request.parameters["metadata"] === "tickets",
        ).length,
        1,
      );
      assert.equal(
        fields(items(fields(report)["completedTicketCosts"])[0])["costUsd"],
        6.6,
      );
    },
  );
});

await test("CLV-243 unavailable GitHub does not read costs beyond the report and baseline window", async () => {
  const now = Date.now();
  const events = [-20 * 86_400_000, -3_600_000, 3_600_000].map(
    (offset, index) =>
      endedEvent(`run-${String(index)}`, {
        outcome: "completed",
        at: new Date(now + offset).toISOString(),
        sequence: index + 1,
      }),
  );
  const runs = [
    {
      runId: "run-1",
      ticketId: null,
      condition: "completed",
      effects: [],
      workerTurns: [],
    },
  ];
  await withReportSource(
    reportReply(events, runs),
    async (harness, requests) => {
      const output = await harness.cli(["report", "--json"]);
      assert.equal(output.status, 0, output.stderr);
      assert.deepEqual(
        requests
          .filter(
            (request) =>
              request.operation === "status" &&
              request.parameters["runId"] !== undefined,
          )
          .map((request) => request.parameters["runId"]),
        ["run-1"],
      );
      assert.equal(
        requests.filter(
          (request) =>
            request.operation === "status" &&
            request.parameters["runId"] === undefined,
        ).length,
        1,
      );
      assert.equal(fields(items(parsed(output)["runCosts"])[0])["costUsd"], 0);
    },
  );
});

await test("CLV-243 phase durations use request to report time and the operation end window", async () => {
  const recent = Date.now() - 3_600_000;
  const events = phaseEvents(recent);
  await withReportSource(reportReply(events), async (harness) => {
    const output = await harness.cli(["report", "--json"]);
    assert.equal(output.status, 0, output.stderr);
    const metrics = fields(parsed(output)["metrics"]);
    for (const [phase, minutes, operations] of [
      ["workerTurn", 3, ["worker-a-3", "worker-b-5"]],
      ["codeReview", 49, ["review-7", "cross-window-11"]],
      ["merge", 12, ["merge-9"]],
    ] as const) {
      const metric = fields(metrics[`phases.${phase}.medianMinutes`]);
      assert.equal(metric["value"], minutes);
      assert.deepEqual(
        items(metric["evidence"]).map((item) => fields(item)["operationId"]),
        operations,
      );
    }
  });
});

await test("CLV-243 completed-ticket cost includes older partial attempts and keeps unknown prices null", async () => {
  const recent = new Date(Date.now() - 1_800_000).toISOString();
  const older = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const partial = {
    ...endedEvent("partial", {
      outcome: "handoff_requested",
      at: older,
      sequence: 1,
    }),
    payload: { outcome: "handoff_requested", ticketStatus: "partial" },
  };
  const events = [
    partial,
    endedEvent("done", { outcome: "completed", at: recent, sequence: 2 }),
  ];
  for (const costUsd of [4.1, null]) {
    const runs = [
      {
        runId: "partial",
        ticketId: "7",
        condition: "completed",
        effects: [],
        workerTurns: [{ operationId: "partial-turn", costUsd }],
      },
      {
        runId: "done",
        ticketId: "7",
        condition: "completed",
        effects: [],
        workerTurns: [{ operationId: "done-turn", costUsd: 2.5 }],
      },
    ];
    await withReportSource(reportReply(events, runs), async (harness) => {
      const output = await configuredReportCli(harness, ["--json"]);
      const report: unknown = JSON.parse(output.stdout);
      const costs = items(fields(report)["completedTicketCosts"]);
      assert.equal(costs.length, 1);
      const ticket = fields(costs[0]);
      assert.equal(ticket["issue"], 7);
      assert.equal(ticket["costUsd"], costUsd === null ? null : 6.6);
      assert.deepEqual(
        items(ticket["runs"]).map((run) => fields(run)["runId"]),
        ["partial", "done"],
      );
      const metric = fields(
        fields(fields(report)["metrics"])["cost.medianCompletedTicketUsd"],
      );
      assert.equal(metric["value"], costUsd === null ? null : 6.6);
      assert.equal(
        metric["status"],
        costUsd === null ? "unavailable" : "available",
      );
    });
  }
});

await test("CLV-243 a mismatched run detail cannot hide an unknown ticket attempt", async () => {
  const at = new Date(Date.now() - 7_200_000).toISOString();
  const events = [
    endedEvent("known", { outcome: "completed", at, sequence: 1 }),
    endedEvent("unreadable", { outcome: "completed", at, sequence: 2 }),
  ];
  const reply = reportReply(events, [
    {
      runId: "known",
      ticketId: "7",
      condition: "completed",
      effects: [],
      workerTurns: [{ operationId: "known-turn", costUsd: 2.5 }],
    },
  ]);
  await withReportSource(
    (request) =>
      request.operation === "status" &&
      request.parameters["runId"] === "unreadable"
        ? {
            kind: "result",
            result: {
              run: {
                runId: "foreign",
                ticketId: null,
                condition: "completed",
                effects: [],
                workerTurns: [],
              },
            },
          }
        : reply(request),
    async (harness) => {
      const output = await configuredReportCli(harness, ["--json"]);
      const report: unknown = JSON.parse(output.stdout);
      assert.equal(
        fields(items(fields(report)["completedTicketCosts"])[0])["costUsd"],
        null,
      );
      assert.equal(
        fields(
          fields(fields(report)["metrics"])["cost.medianCompletedTicketUsd"],
        )["status"],
        "unavailable",
      );
    },
  );
});
