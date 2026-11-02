import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCycleOutcome,
  validateDevelopmentInput,
} from "../src/workflow-contracts.ts";

await test("CLV-200 review outcomes retain a bounded report in the run result", () => {
  const base = {
    kind: "handoff_requested",
    cycleId: "review-1",
    promotionId: "review-day",
  };
  const outcome = { ...base, report: "# Daily review\n\n## Facts\nAvailable." };
  assert.deepEqual(validateCycleOutcome(outcome, base), {
    kind: "valid",
    value: outcome,
  });
  for (const report of [null, 7, "", "x".repeat(65537)])
    assert.equal(
      validateCycleOutcome({ ...base, report }, base).kind,
      "invalid",
    );
});

await test("CLV-005 development input admits only one bounded cycle identity", () => {
  assert.deepEqual(validateDevelopmentInput({ cycleId: "cycle-1" }), {
    kind: "valid",
    value: { cycleId: "cycle-1" },
  });
  for (const value of [
    null,
    [],
    {},
    { cycleId: 1 },
    { cycleId: "" },
    { cycleId: "x".repeat(129) },
    { cycleId: "has space" },
    { cycleId: "cycle-1", extra: true },
  ])
    assert.deepEqual(validateDevelopmentInput(value), {
      kind: "invalid",
      reason: "invalid-development-input",
    });
});

await test("CLV-005 cycle outcomes must be a known tagged result for the same cycle", () => {
  const input = { cycleId: "cycle-1" };
  for (const outcome of [
    { kind: "waiting_for_decision", cycleId: "cycle-1", decisionId: "d-1" },
    {
      kind: "blocked",
      cycleId: "cycle-1",
      reason: "repair_limit",
      evidenceId: "e-1",
    },
    { kind: "handoff_requested", cycleId: "cycle-1", promotionId: "p-1" },
  ])
    assert.deepEqual(validateCycleOutcome(outcome, input), {
      kind: "valid",
      value: outcome,
    });
  for (const outcome of [
    null,
    { kind: "accepted", cycleId: "cycle-1" },
    { kind: "waiting_for_decision", cycleId: "cycle-1" },
    { kind: "waiting_for_decision", cycleId: "cycle-2", decisionId: "d-1" },
    { kind: "handoff_requested", cycleId: "cycle-1", promotionId: 1 },
    {
      kind: "handoff_requested",
      cycleId: "cycle-1",
      promotionId: "p-1",
      extra: "x",
    },
    {
      kind: "blocked",
      cycleId: "cycle-1",
      reason: "x".repeat(257),
      evidenceId: "e-1",
    },
    { kind: "toString", cycleId: "cycle-1" },
    { kind: "hasOwnProperty", cycleId: "cycle-1" },
    { kind: "__proto__", cycleId: "cycle-1" },
  ])
    assert.deepEqual(validateCycleOutcome(outcome, input), {
      kind: "invalid",
      reason: "invalid-cycle-outcome",
    });
});

await test("CLV-123 merged outcomes retain a valid ticket status and reject other status values", () => {
  const base = {
    kind: "handoff_requested",
    cycleId: "cycle-1",
    promotionId: "pull-request-7",
  };
  for (const ticketStatus of ["complete", "partial"])
    assert.deepEqual(
      validateCycleOutcome({ ...base, ticketStatus }, { cycleId: "cycle-1" }),
      {
        kind: "valid",
        value: { ...base, ticketStatus },
      },
    );
  for (const ticketStatus of ["unknown", 1, null])
    assert.equal(
      validateCycleOutcome({ ...base, ticketStatus }, { cycleId: "cycle-1" })
        .kind,
      "invalid",
    );
});

await test("CLV-169 completed issue promotions retain a bounded handoff refusal reason", () => {
  const base = {
    kind: "handoff_requested",
    cycleId: "cycle-1",
    promotionId: "issue-42",
  };
  const outcome = { ...base, reason: "handoff-start-timeout" };
  assert.deepEqual(validateCycleOutcome(outcome, base), {
    kind: "valid",
    value: outcome,
  });
  for (const reason of [null, 7, "", " leading", "x".repeat(257)])
    assert.equal(
      validateCycleOutcome({ ...base, reason }, base).kind,
      "invalid",
    );
});
