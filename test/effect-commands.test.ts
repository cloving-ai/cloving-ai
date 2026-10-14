import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/authority/commands.ts";
import {
  operationIdentity,
  operationScope,
} from "../src/operation-identity.ts";

const digest = `sha256:${"a".repeat(64)}`;
const operationId = '["cloving-operation",1,"run-1","work","effect",null,null]';
const base = { runId: "run-1", commandId: "c-1" };

const request = {
  ...base,
  kind: "request-effect",
  operationId,
  capability: "fake-harness",
  method: "run-turn",
  target: "workspace/main",
  payload: digest,
  inputDigest: digest,
  units: 1,
  recoveryLimit: 3,
};

const report = {
  ...base,
  kind: "report-effect",
  operationId,
  inputDigest: digest,
  leaseGeneration: 1,
  worker: "worker-1",
  outcome: "completed",
  result: digest,
};

const outcome = { ...base, kind: "record-outcome", operationId };

await test("CLV-049 the command check accepts each protected effect command with its fields", () => {
  for (const command of [
    request,
    { ...request, resource: "repository", transport: "retry 2 of call-7" },
    { ...request, source: operationId, sourceGeneration: 2 },
    { ...request, units: 0 },
    { ...request, recoveryLimit: 10 },
    {
      ...base,
      kind: "grant-lease",
      operationId,
      leaseGeneration: 1,
      expiresAt: "2026-10-10T12:10:00.000Z",
      capacity: 4,
    },
    { ...base, kind: "expire-lease", operationId, leaseGeneration: 1 },
    report,
    { ...report, outcome: "failed", result: undefined, reason: "tool-exit" },
    { ...report, outcome: "failed", reason: "tool-exit" },
    { ...report, outcome: "stopped", result: undefined },
    {
      ...outcome,
      outcome: "accepted",
      leaseGeneration: 1,
      receipt: "r-1",
      worker: "w-1",
    },
    {
      ...outcome,
      outcome: "not-started",
      leaseGeneration: 1,
      reason: "withheld",
    },
    {
      ...outcome,
      outcome: "unknown",
      leaseGeneration: 1,
      reason: "time-limit",
    },
    { ...outcome, outcome: "stopped" },
  ])
    assert.notEqual(parseCommand(command), null, JSON.stringify(command));
});

await test("CLV-049 the command check rejects a protected effect command with a field of a wrong form", () => {
  for (const command of [
    { ...request, operationId: "op-é" },
    { ...request, capability: "fake harness" },
    { ...request, target: "" },
    { ...request, target: "x".repeat(513) },
    { ...request, transport: "line\nbreak" },
    { ...request, payload: "the text" },
    { ...request, inputDigest: "sha256:abc" },
    { ...request, units: -1 },
    { ...request, units: 1.5 },
    { ...request, recoveryLimit: 0 },
    { ...request, recoveryLimit: 11 },
    { ...request, resource: "constructor" },
    { ...request, resource: "two words" },
    { ...request, source: operationId },
    { ...request, sourceGeneration: 1 },
    { ...request, recoveryClass: "idempotent" },
    { ...request, outcome: "completed" },
    { ...report, outcome: "accepted" },
    { ...report, outcome: "accepted", result: undefined },
    { ...report, outcome: "not-started", result: undefined },
    { ...report, outcome: "unknown", result: undefined },
    { ...report, outcome: "completed", result: undefined },
    { ...report, outcome: "failed", result: undefined },
    { ...report, outcome: "stopped", reason: "tool-exit", result: digest },
    { ...report, outcome: "stopped" },
    { ...report, leaseGeneration: 0 },
    { ...report, worker: "" },
    { ...outcome, outcome: "sent" },
    { ...outcome, outcome: "accepted", capacity: 4 },
  ])
    assert.equal(parseCommand(command), null, JSON.stringify(command));
});

const admission = { ...base, kind: "admit-run", workflow: digest };

await test("CLV-049 an admission with an effect limit names the capabilities of the run, and an admission with no effect limit stays valid", () => {
  assert.notEqual(parseCommand(admission), null);
  for (const capabilities of ["[]", '["fake-harness"]', '["a","b"]'])
    assert.notEqual(
      parseCommand({ ...admission, effectLimit: 0, capabilities }),
      null,
      capabilities,
    );
  for (const group of [
    { effectLimit: 2 },
    { capabilities: "[]" },
    { effectLimit: -1, capabilities: "[]" },
    { effectLimit: 2, capabilities: '["b","a"]' },
    { effectLimit: 2, capabilities: '["a","a"]' },
    { effectLimit: 2, capabilities: '["a b"]' },
    { effectLimit: 2, capabilities: '[ "a" ]' },
    { effectLimit: 2, capabilities: '{"a":1}' },
    { effectLimit: 2, capabilities: "not json" },
    {
      effectLimit: 2,
      capabilities: JSON.stringify(
        Array.from({ length: 65 }, (_, index) => `c${String(index + 100)}`),
      ),
    },
  ])
    assert.equal(
      parseCommand({ ...admission, ...group }),
      null,
      JSON.stringify(group),
    );
});

await test("CLV-049 the run and the operation name of an operation identity can be read from its text", () => {
  const identity = operationIdentity({
    run: "run-7",
    phase: "work",
    round: 3,
    operation: "effect",
    key: "attempt-1",
  });
  assert.equal(identity.kind, "valid");
  assert.deepEqual(operationScope(Reflect.get(identity, "value")), {
    run: "run-7",
    operation: "effect",
  });
  assert.deepEqual(operationScope(operationId), {
    run: "run-1",
    operation: "effect",
  });
  for (const text of [
    "",
    "run-1",
    "[]",
    '["other",1,"run-1","work","effect",null,null]',
    '["cloving-operation",1,7,"work","effect",null,null]',
    '["cloving-operation",1,"run-1","work",7,null,null]',
    '{"run":"run-1"}',
    "[1,",
  ])
    assert.equal(operationScope(text), null, text);
});
