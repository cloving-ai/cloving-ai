import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dispatchDecision,
  type DispatchRead,
} from "../src/authority/dispatch-decision.ts";
import {
  checkRequest,
  inputDigest,
  key,
  start,
  waitLedger,
} from "./command-wait-check-fixture.ts";

function dispatchFixture() {
  const ledger = waitLedger();
  ledger.ordinary(1);
  ledger.ordinary(2);
  ledger.ordinary(3);
  ledger.accept(checkRequest);
  const state = ledger.state();
  const wait = state.commandWaits?.[key];
  assert.ok(wait?.checkOperation);
  const operation = state.effects.operations[wait.checkOperation];
  assert.ok(operation);
  const intent = {
    operationId: operation.operationId,
    inputDigest,
    computedDigest: inputDigest,
    workflow: "pin-1",
    leaseGeneration: 1,
  };
  const read = {
    attempt: { outcome: null, inputDigest, leaseGeneration: 1 },
    released: false,
    runStatus: "running",
    workflow: "pin-1",
    pinned: true,
    operation: { ...operation, status: "dispatch-pending" },
    budget: state.effects.budgets["run-1"],
    lease: {
      operationId: operation.operationId,
      generation: 1,
      expiresAt: new Date(wait.deadline + 1000).toISOString(),
      state: "held",
    },
    commandWait: { wait, declared: true },
  };
  return { read, intent, wait, now: new Date(start).toISOString() };
}

await test("CLV-236 dispatch uses the durable declared wait after ordinary budget exhaustion", () => {
  const { read, intent, now } = dispatchFixture();
  assert.equal(dispatchDecision(read, { intent, now }), "send");
});

await test("CLV-236 dispatch rechecks wait declaration, ownership, input, schedule and deadline", () => {
  const { read, intent, wait, now } = dispatchFixture();
  const { commandWait, ...absent } = read;
  assert.ok(commandWait);
  const cases: readonly DispatchRead[] = [
    absent,
    { ...read, commandWait: { wait, declared: false } },
    {
      ...read,
      commandWait: { wait: { ...wait, state: "completed" }, declared: true },
    },
    {
      ...read,
      commandWait: {
        wait: { ...wait, checkOperation: "other" },
        declared: true,
      },
    },
    {
      ...read,
      commandWait: {
        wait: { ...wait, nextCheckAt: start + 1 },
        declared: true,
      },
    },
    { ...read, operation: { ...read.operation, payload: "forged" } },
    { ...read, operation: { ...read.operation, units: 0 } },
  ];
  for (const candidate of cases)
    assert.notEqual(dispatchDecision(candidate, { intent, now }), "send");
  for (const time of [wait.deadline, wait.deadline + 1])
    assert.notEqual(
      dispatchDecision(read, { intent, now: new Date(time).toISOString() }),
      "send",
    );
  for (const status of ["paused", "completed", "failed", "cancelled"])
    assert.notEqual(
      dispatchDecision({ ...read, runStatus: status }, { intent, now }),
      "send",
    );
});
