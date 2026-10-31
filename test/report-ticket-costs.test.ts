import assert from "node:assert/strict";
import { test } from "node:test";
import { loopReport } from "../src/report.ts";
import { fields, items } from "./service-fixture.ts";

const now = Date.parse("2026-10-25T00:00:00Z");
const at = now - 3_600_000;

await test("CLV-243 ticket costs group all attempts by ticket and preserve a known ticket beside an unknown ticket", () => {
  const completions = ["partial", "done", "other"].map((runId, index) => ({
    runId,
    sequence: index + 1,
    at,
    outcome: "completed" as const,
  }));
  for (const costUsd of [4.1, null]) {
    const report = loopReport({
      now,
      since: 24,
      completions,
      costs: [
        {
          runId: "partial",
          ticketId: "7",
          turns: [{ operationId: "partial-turn", costUsd }],
        },
        {
          runId: "done",
          ticketId: "7",
          turns: [{ operationId: "done-turn", costUsd: 2.5 }],
        },
        {
          runId: "other",
          ticketId: "8",
          turns: [{ operationId: "other-turn", costUsd: 1 }],
        },
      ],
      github: {
        issues: [7, 8].map((issue) => ({ at, value: 1, evidence: { issue } })),
        pulls: [],
        sources: {},
      },
    });
    const tickets = items(report["completedTicketCosts"]).map(fields);
    assert.deepEqual(
      tickets.map((ticket) => [ticket["issue"], ticket["costUsd"]]),
      [
        [7, costUsd === null ? null : 6.6],
        [8, 1],
      ],
    );
    assert.deepEqual(items(fields(tickets[0]?.["evidence"])["runIds"]), [
      "partial",
      "done",
    ]);
    const metric = fields(
      fields(report["metrics"])["cost.medianCompletedTicketUsd"],
    );
    assert.equal(metric["value"], costUsd === null ? null : 3.8);
  }
});

await test("CLV-243 missing daemon or run history cannot manufacture a completed-ticket cost", () => {
  const github = {
    issues: [{ at, value: 1, evidence: { issue: 7 } }],
    pulls: [],
    sources: {},
  };
  for (const completions of [[], null]) {
    const report = loopReport({ now, since: 24, completions, github });
    assert.equal(
      fields(items(report["completedTicketCosts"])[0])["costUsd"],
      null,
    );
    assert.equal(
      fields(fields(report["metrics"])["cost.medianCompletedTicketUsd"])[
        "status"
      ],
      "unavailable",
    );
  }
});
