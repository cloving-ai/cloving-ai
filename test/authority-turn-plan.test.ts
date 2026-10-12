import assert from "node:assert/strict";
import { test } from "node:test";
import { effectSettings } from "../src/broker/actor/authority-settings.ts";
import { deliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import {
  planCommand,
  planDelivery,
  type DeliveryResult,
  type TurnPlan,
  type TurnState,
} from "../src/broker/actor/turn-plan.ts";
import { admit, lastState, recorded, run } from "./authority-fixture.ts";

const operationId =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';
const start = { kind: "start-run", runId: "run-1", operationId } as const;

function turn(
  commands: readonly Readonly<Record<string, unknown>>[],
  held: readonly string[],
): TurnState {
  return {
    state: lastState(run(commands)),
    definitions: new Map(),
    held: new Set(held),
    blocked: new Map(),
    stopping: { subjects: [], cancelledSequence: null },
    runId: "run-1",
    created: [],
    documents: new Set(),
  };
}

const paused = {
  kind: "pause-run",
  commandId: "c-2",
  runId: "run-1",
  expectedRevision: 1,
};

function result(
  outcome: DeliveryResult["outcome"],
  overrides: Partial<DeliveryResult> = {},
): DeliveryResult {
  return {
    effectId: "effect-1",
    operationId,
    runId: "run-1",
    intent: "start-run",
    leaseGeneration: null,
    purpose: "dispatch",
    attempts: 2,
    outcome,
    receipt: outcome === "sent" ? "receipt-1" : null,
    worker: null,
    result: null,
    reason: null,
    epoch: 3,
    recordedAt: recorded.recordedAt,
    ...overrides,
  };
}

function committed(plan: TurnPlan): Extract<TurnPlan, { kind: "commit" }> {
  assert.equal(plan.kind, "commit");
  return plan;
}

await test("CLV-042 a withheld delivery whose run is eligible again at the callback stages the same operation again", () => {
  const plan = committed(
    planDelivery({
      turn: turn([admit], [operationId]),
      delivery: result("withheld"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(plan.stage, [
    deliveryIntent({ ...start, workflow: "pin-1" }),
  ]);
  assert.deepEqual(plan.change.closed, [
    { effect_id: "effect-1", outcome: "withheld", receipt: null },
  ]);
});

await test("CLV-042 a withheld delivery of an ineligible run closes without staging", () => {
  const plan = committed(
    planDelivery({
      turn: turn([admit, paused], [operationId]),
      delivery: result("withheld"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(plan.stage, []);
});

await test("CLV-042 a delivery result from an older epoch records no dispatch and stages a new delivery that reconciles first", () => {
  const plan = committed(
    planDelivery({
      turn: turn([admit], [operationId]),
      delivery: result("sent", { epoch: 2 }),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(plan.change.events, []);
  assert.deepEqual(plan.change.closed, [
    { effect_id: "effect-1", outcome: "stale-epoch", receipt: "receipt-1" },
  ]);
  assert.deepEqual(plan.stage, [
    deliveryIntent({ ...start, workflow: "pin-1" }),
  ]);
});

await test("CLV-042 a sent delivery records its dispatch with a digest command identity and stages nothing", () => {
  const plan = committed(
    planDelivery({
      turn: turn([admit], [operationId]),
      delivery: result("sent"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(
    plan.change.events.map((event) => [
      event["type"],
      String(event["command_id"]).startsWith("dispatch:"),
    ]),
    [["step.dispatched", true]],
  );
  assert.deepEqual(plan.change.released, [
    { operation_id: operationId, released_sequence: 2 },
  ]);
  assert.deepEqual(plan.stage, []);
});

await test("CLV-042 a failed delivery closes without staging, and a sent delivery for a released intent keeps its receipt without an event", () => {
  const failed = committed(
    planDelivery({
      turn: turn([admit], [operationId]),
      delivery: result("failed"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(failed.stage, []);
  const cancelled = committed(
    planDelivery({
      turn: turn(
        [admit, { ...paused, kind: "cancel-run", commandId: "c-3" }],
        [operationId],
      ),
      delivery: result("sent"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(cancelled.change.events, []);
  assert.deepEqual(cancelled.change.closed, [
    { effect_id: "effect-1", outcome: "sent", receipt: "receipt-1" },
  ]);
});

await test("CLV-042 a dispatch record submitted as a command is reserved for delivery", () => {
  assert.deepEqual(
    planCommand({
      turn: turn([admit], []),
      request: {
        command: {
          kind: "record-dispatch",
          commandId: "c-2",
          runId: "run-1",
          operationId,
          receipt: "forged",
        },
        recordedAt: recorded.recordedAt,
      },
      epoch: 3,
      effects: effectSettings,
    }),
    {
      kind: "answer",
      receipt: { kind: "rejected", reason: "delivery-owned-command" },
    },
  );
});

await test("CLV-042 a committed command retried with an older epoch returns its stored receipt, and a conflicting reuse is still a conflict", () => {
  const started = {
    kind: "mark-started",
    commandId: "c-2",
    runId: "run-1",
    expectedRevision: 1,
  };
  const turnState = turn([admit, started], []);
  assert.deepEqual(
    planCommand({
      turn: turnState,
      request: { command: started, recordedAt: recorded.recordedAt, epoch: 1 },
      epoch: 2,
      effects: effectSettings,
    }),
    {
      kind: "answer",
      receipt: { kind: "duplicate", sequence: 2, intents: [] },
    },
  );
  assert.deepEqual(
    planCommand({
      turn: turnState,
      request: {
        command: { ...started, expectedRevision: 9 },
        recordedAt: recorded.recordedAt,
        epoch: 1,
      },
      epoch: 2,
      effects: effectSettings,
    }),
    {
      kind: "answer",
      receipt: { kind: "rejected", reason: "conflicting-command" },
    },
  );
});

await test("CLV-042 a recorded dispatch retried as a command returns its stored receipt", () => {
  const dispatch = {
    kind: "record-dispatch",
    commandId: "dispatch:1",
    runId: "run-1",
    operationId,
    receipt: "receipt-1",
  };
  assert.deepEqual(
    planCommand({
      turn: turn([admit, dispatch], []),
      request: { command: dispatch, recordedAt: recorded.recordedAt },
      epoch: 3,
      effects: effectSettings,
    }),
    {
      kind: "answer",
      receipt: { kind: "duplicate", sequence: 2, intents: [] },
    },
  );
});

await test("CLV-008 a dispatch record for a pending intent of a run that is not eligible is recorded as a fact and stages nothing", () => {
  const plan = committed(
    planDelivery({
      turn: turn([admit, paused], [operationId]),
      delivery: result("sent"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(
    plan.change.events.map((event) => [event["type"], event["run_id"]]),
    [["step.dispatched", "run-1"]],
  );
  assert.deepEqual(plan.change.released, [
    { operation_id: operationId, released_sequence: 3 },
  ]);
  assert.deepEqual(plan.change.closed, [
    { effect_id: "effect-1", outcome: "sent", receipt: "receipt-1" },
  ]);
  assert.deepEqual(plan.stage, []);
});

await test("CLV-008 a blocked delivery closes with its outcome and is not staged again in the same opening", () => {
  const plan = committed(
    planDelivery({
      turn: turn([admit], [operationId]),
      delivery: result("blocked"),
      epoch: 3,
      effects: effectSettings,
    }),
  );
  assert.deepEqual(plan.change.events, []);
  assert.deepEqual(plan.change.closed, [
    { effect_id: "effect-1", outcome: "blocked", receipt: null },
  ]);
  assert.deepEqual(plan.stage, []);
});
