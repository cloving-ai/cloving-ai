import assert from "node:assert/strict";
import { test } from "node:test";
import type { StopSubject } from "../src/authority/stop-sequence.ts";
import { reconciliations } from "../src/broker/actor/effect-plan.ts";
import { effectSettings } from "../src/broker/actor/authority-settings.ts";
import { stopIntents } from "../src/broker/actor/stop-plan.ts";
import { planDelivery } from "../src/broker/actor/turn-plan.ts";
import {
  admission,
  applied,
  grant,
  operationOf,
  outcome,
  request,
  started,
} from "./effect-pure-fixture.ts";

const cancel = {
  kind: "cancel-run",
  commandId: "c-cancel",
  runId: "run-1",
  expectedRevision: 2,
};

const dropped = applied([
  admission,
  started,
  request(1),
  grant({ round: 1, generation: 1 }),
  outcome(1, { outcome: "unknown", reason: "time-limit" }),
  cancel,
]);

const earlier = [1, 2, 3].map((count) => ({
  effectId: `effect-${String(count)}`,
  purpose: "reconcile",
  outcome: "unknown",
  stagedSequence: 5,
}));

const subject: StopSubject = {
  operationId: operationOf(1),
  kind: "protected-effect",
  attempts: earlier,
  status: "recovering",
  receipt: null,
  stopped: false,
};

const planning = {
  stopping: { subjects: [subject], cancelledSequence: null },
  runId: "run-1",
  closed: [],
  cancelledNow: [dropped.state.sequence],
  stopLimit: 3,
  stopSupported: true,
  opening: false,
  rejected: new Set<string>(),
};

function staged(intents: ReturnType<typeof stopIntents>): readonly unknown[] {
  return intents.map((intent) => [
    intent.operationId,
    intent.purpose,
    intent.leaseGeneration,
  ]);
}

await test("CLV-049 the stop bound of the turn that drops a run counts no attempt from before the drop", () => {
  assert.deepEqual(staged(stopIntents(dropped.state, planning)), [
    [operationOf(1), "reconcile", 1],
  ]);
  assert.deepEqual(
    stopIntents(dropped.state, {
      ...planning,
      cancelledNow: [],
      stopping: { subjects: [subject], cancelledSequence: 5 },
    }),
    [],
  );
});

await test("CLV-049 the stop sequence, not the recovery rule of a run in work, gives the attempts of a recovering operation of a dropped run", () => {
  assert.equal(
    dropped.state.effects.operations[operationOf(1)]?.status,
    "recovering",
  );
  assert.deepEqual(
    reconciliations(dropped.state, {
      results: [dropped.last],
      closed: [operationOf(1)],
      open: new Set(),
    }),
    [],
  );
});

const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

const droppedStart = applied([admission, { ...cancel, expectedRevision: 1 }]);

const reconciling: StopSubject = {
  operationId: startOperation,
  kind: "start-run",
  attempts: [
    {
      effectId: "effect-0",
      purpose: "dispatch",
      outcome: "failed",
      stagedSequence: 1,
    },
    {
      effectId: "effect-1",
      purpose: "reconcile",
      outcome: null,
      stagedSequence: 2,
    },
  ],
  status: null,
  receipt: null,
  stopped: false,
};

await test("CLV-049 a callback of an earlier epoch for a reconciliation of a dropped run is closed as stale-epoch, and the next attempt of the stop sequence follows in the same turn", () => {
  const plan = planDelivery({
    turn: {
      state: droppedStart.state,
      definitions: new Map(),
      held: new Set([startOperation]),
      blocked: new Map(),
      stopping: { subjects: [reconciling], cancelledSequence: 2 },
      runId: "run-1",
      created: [],
      documents: new Set(),
    },
    delivery: {
      effectId: "effect-1",
      operationId: startOperation,
      runId: "run-1",
      intent: "start-run",
      leaseGeneration: null,
      purpose: "reconcile",
      attempts: 0,
      outcome: "absent",
      receipt: null,
      worker: null,
      result: null,
      reason: null,
      epoch: 2,
      recordedAt: "2026-10-10T12:00:00.000Z",
    },
    epoch: 3,
    effects: effectSettings,
  });
  assert.equal(plan.kind, "commit");
  assert.deepEqual(plan.change.closed, [
    { effect_id: "effect-1", outcome: "stale-epoch", receipt: null },
  ]);
  assert.deepEqual(
    plan.stage.map((intent) => [intent.operationId, intent.purpose]),
    [[startOperation, "reconcile"]],
  );
});
