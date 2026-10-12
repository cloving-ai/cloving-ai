import assert from "node:assert/strict";
import { test } from "node:test";
import { effectSettings } from "../src/broker/actor/authority-settings.ts";
import { reconciliations } from "../src/broker/actor/effect-plan.ts";
import {
  planDelivery,
  type DeliveryResult,
  type TurnState,
} from "../src/broker/actor/turn-plan.ts";
import { admit, lastState, run } from "./authority-fixture.ts";
import {
  accepted,
  admission,
  applied,
  grant,
  later,
  letters,
  noon,
  operationOf,
  outcome,
  report,
  request,
  started,
  appliedAt,
} from "./effect-pure-fixture.ts";

const pending = applied([
  admission,
  started,
  request(1),
  grant({ round: 1, generation: 1 }),
]).state;

const unknown = outcome(1, { outcome: "unknown", reason: "time-limit" });
const recovering = applied([unknown], pending);
const none: ReadonlySet<string> = new Set();

function purposes(
  intents: ReturnType<typeof reconciliations>,
): readonly unknown[] {
  return intents.map((intent) => [
    intent.operationId,
    intent.purpose,
    intent.leaseGeneration,
  ]);
}

await test("CLV-049 an operation that is recovering after an event or a closed attempt of the turn gets one reconciliation attempt, and an operation with an open attempt gets none", () => {
  const { state, last } = recovering;
  const expected = [[operationOf(1), "reconcile", 1]];
  assert.deepEqual(
    purposes(
      reconciliations(state, { results: [last], closed: [], open: none }),
    ),
    expected,
  );
  assert.deepEqual(
    purposes(
      reconciliations(state, {
        results: [],
        closed: [operationOf(1)],
        open: none,
      }),
    ),
    expected,
  );
  assert.deepEqual(
    reconciliations(state, {
      results: [last],
      closed: [operationOf(1)],
      open: new Set([operationOf(1)]),
    }),
    [],
  );
  assert.deepEqual(
    reconciliations(state, { results: [], closed: [], open: none }),
    [],
  );
});

await test("CLV-049 an acceptance under an expired lease in the turn starts no reconciliation in that turn", () => {
  const late = appliedAt(later, { steps: [accepted(1)], start: pending });
  assert.equal(
    late.state.effects.operations[operationOf(1)]?.status,
    "recovering",
  );
  assert.deepEqual(
    reconciliations(late.state, {
      results: [late.last],
      closed: [operationOf(1)],
      open: none,
    }),
    [],
  );
});

await test("CLV-049 a blocked operation gets a reconciliation attempt only in a turn that rejects a report of that operation", () => {
  const blocked = applied(
    [2, 3].map((count) => ({
      ...unknown,
      commandId: `c-unknown-${String(count)}`,
    })),
    recovering.state,
  );
  assert.equal(
    blocked.state.effects.operations[operationOf(1)]?.status,
    "blocked",
  );
  assert.deepEqual(
    reconciliations(blocked.state, {
      results: [blocked.last],
      closed: [operationOf(1)],
      open: none,
    }),
    [],
  );
  const rejected = applied([report(1)], blocked.state);
  assert.equal(rejected.last.disposition?.disposition, "rejected");
  assert.deepEqual(
    purposes(
      reconciliations(rejected.state, {
        results: [rejected.last],
        closed: [],
        open: none,
      }),
    ),
    [[operationOf(1), "reconcile", 1]],
  );
});

function turn(state: TurnState["state"], held: readonly string[]): TurnState {
  return {
    state,
    definitions: new Map(),
    held: new Set(held),
    blocked: new Map(),
    stopping: { subjects: [], cancelledSequence: null },
    runId: "run-1",
    created: [],
    documents: new Set(),
  };
}

const closing: DeliveryResult = {
  effectId: "effect-1",
  operationId: operationOf(1),
  runId: "run-1",
  intent: "protected-effect",
  leaseGeneration: 1,
  purpose: "dispatch",
  attempts: 1,
  outcome: "thrown",
  receipt: null,
  worker: null,
  result: null,
  reason: null,
  epoch: 3,
  recordedAt: noon,
};

function planned(delivery: DeliveryResult, state: TurnState["state"]) {
  const plan = planDelivery({
    turn: turn(state, [delivery.operationId]),
    delivery,
    epoch: 3,
    effects: effectSettings,
  });
  assert.equal(plan.kind, "commit");
  return plan;
}

await test("CLV-049 a thrown handler of a protected attempt is recorded as an unknown outcome, and one reconciliation attempt follows in the same turn", () => {
  const plan = planned(closing, pending);
  assert.deepEqual(
    plan.change.events.map((event): readonly unknown[] => [
      event["type"],
      event["command_id"],
      JSON.parse(String(event["payload"])),
    ]),
    [
      [
        "operation.reconciled",
        "outcome:effect-1",
        {
          operationId: operationOf(1),
          leaseGeneration: "1",
          outcome: "unknown",
          reason: "handler-failure",
        },
      ],
    ],
  );
  assert.deepEqual(plan.change.closed, [
    { effect_id: "effect-1", outcome: "failed", receipt: null },
  ]);
  assert.deepEqual(
    plan.stage.map((intent) => [
      intent.purpose,
      intent.inputDigest,
      intent.leaseGeneration,
    ]),
    [["reconcile", letters("b"), 1]],
  );
});

const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

await test("CLV-049 a thrown handler of a start is staged again below the bound of delivery attempts of the opening, and not at the bound", () => {
  const queued = lastState(run([admit]));
  const start: DeliveryResult = {
    ...closing,
    operationId: startOperation,
    intent: "start-run",
    leaseGeneration: null,
  };
  assert.deepEqual(
    planned(start, queued).stage.map((intent) => [intent.kind, intent.purpose]),
    [["start-run", "dispatch"]],
  );
  assert.deepEqual(planned({ ...start, attempts: 2 }, queued).stage, []);
  const protectedAttempt = planDelivery({
    turn: turn(pending, [operationOf(1)]),
    delivery: { ...closing, outcome: "blocked" },
    epoch: 3,
    effects: effectSettings,
  });
  assert.equal(protectedAttempt.kind, "commit");
  assert.deepEqual(protectedAttempt.stage, []);
});

await test("CLV-049 an attempt that closes with no event for an operation that is recovering starts one reconciliation attempt", () => {
  const plan = planned({ ...closing, outcome: "blocked" }, recovering.state);
  assert.deepEqual(plan.change.events, []);
  assert.deepEqual(
    plan.stage.map((intent) => [intent.operationId, intent.purpose]),
    [[operationOf(1), "reconcile"]],
  );
});
