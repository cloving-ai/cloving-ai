import assert from "node:assert/strict";
import { test } from "node:test";
import { operationIdentity } from "../src/operation-identity.ts";

const scope = {
  run: "run-1",
  phase: "plan",
  round: 1,
  stage: { id: "build", visit: "round-1/phase-plan", branch: "main" },
  operation: "implement",
  key: "turn-1",
};

function identity(value: unknown): string {
  const result = operationIdentity(value);
  assert.equal(result.kind, "valid");
  return result.value;
}

await test("CLV-005 SDK attempts and execution segments reuse one logical operation identity", () => {
  assert.equal(
    identity({ ...scope, attempt: 3, segment: "segment-2", sdkRunId: "wrun" }),
    identity(scope),
  );
});

await test("CLV-005 visits, rounds, phases, branches and keys never share an operation identity", () => {
  const variants = [
    scope,
    { ...scope, round: 2 },
    { ...scope, phase: "repair" },
    { ...scope, run: "run-2" },
    { ...scope, operation: "verifyRed" },
    { ...scope, key: "turn-2" },
    { ...scope, stage: { ...scope.stage, visit: "round-2/phase-plan" } },
    { ...scope, stage: { ...scope.stage, branch: "secondary" } },
    { ...scope, stage: { ...scope.stage, id: "verify" } },
    {
      ...scope,
      stage: { ...scope.stage, visit: "round-1", branch: "phase-plan/main" },
    },
  ];
  assert.equal(new Set(variants.map(identity)).size, variants.length);
});

await test("CLV-005 malformed operation scopes are rejected", () => {
  for (const value of [
    null,
    { ...scope, round: -1 },
    { ...scope, round: 1.5 },
    { ...scope, run: "" },
    { ...scope, key: " " },
    { ...scope, stage: { id: "build", visit: "round-1" } },
    { ...scope, stage: null },
    { ...scope, key: null },
  ])
    assert.deepEqual(operationIdentity(value), {
      kind: "invalid",
      reason: "invalid-operation-scope",
    });
});

await test("CLV-005 operations outside a stage or without a repeat key still get distinct identities", () => {
  const parked = {
    run: "run-1",
    phase: "plan",
    round: 1,
    operation: "parkCycle",
  };
  const identities = [
    identity(parked),
    identity({ ...parked, key: "phase-plan/repair-limit" }),
    identity({ ...parked, stage: scope.stage }),
    identity({ ...parked, stage: scope.stage, key: "phase-plan/repair-limit" }),
  ];
  assert.equal(new Set(identities).size, identities.length);
});
