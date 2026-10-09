import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCycleOutcome,
  validateDevelopmentInput,
} from "../src/workflow-contracts.ts";

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
