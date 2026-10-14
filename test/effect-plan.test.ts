import assert from "node:assert/strict";
import { test } from "node:test";
import { effectSettings } from "../src/broker/actor/authority-settings.ts";
import { stageable } from "../src/broker/actor/delivery-intents.ts";
import {
  outcomeCommand,
  promoted,
  resultDocuments,
} from "../src/broker/actor/effect-plan.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  admission,
  applied,
  grant,
  letters,
  noon,
  operationOf,
  request,
  started,
} from "./effect-pure-fixture.ts";

const waiting = applied([
  { ...admission, effectLimit: 8 },
  started,
  request(1),
  request(2),
]).state;

await test("CLV-049 the promotion steps grant each waiting operation in sequence, each from the state after the earlier grant", () => {
  const steps = promoted(waiting, {
    recordedAt: noon,
    effects: effectSettings,
  });
  assert.deepEqual(
    steps.map((step) => [
      step.before.sequence,
      step.result.state.sequence,
      step.result.events[0]?.payload["operationId"],
      step.result.events[0]?.payload["leaseGeneration"],
      step.result.state.effects.holding,
    ]),
    [
      [4, 5, operationOf(1), "1", 1],
      [5, 6, operationOf(2), "1", 2],
    ],
  );
});

await test("CLV-049 the promotion makes no grant at a recorded time that is not an instant, and none above the capacity setting", () => {
  assert.deepEqual(
    promoted(waiting, { recordedAt: "", effects: effectSettings }),
    [],
  );
  const bounded = promoted(waiting, {
    recordedAt: noon,
    effects: { ...effectSettings, capacity: 1 },
  });
  assert.deepEqual(
    bounded.map((step) => step.result.events[0]?.payload["capacity"]),
    ["1"],
  );
});

await test("CLV-049 a granted operation is staged as a dispatch attempt with its lease generation and its effect input, and an operation with an open attempt is not staged again", () => {
  const { state } = applied([grant({ round: 1, generation: 1 })], waiting);
  assert.deepEqual(stageable(state, new Set()), [
    {
      kind: "protected-effect",
      runId: "run-1",
      operationId: operationOf(1),
      workflow: "pin-1",
      purpose: "dispatch",
      inputDigest: letters("b"),
      leaseGeneration: 1,
      capability: "fake-harness",
      method: "run-turn",
      target: "workspace/main",
      payload: letters("a"),
    },
  ]);
  assert.deepEqual(stageable(state, new Set([operationOf(1)])), []);
});

const attempt = {
  effectId: "effect-1",
  operationId: operationOf(1),
  runId: "run-1",
  leaseGeneration: 2,
  purpose: "dispatch",
  receipt: "receipt-1",
  worker: "worker-2",
  result: null,
  reason: null,
  storedReceipt: null,
};

await test("CLV-049 the outcome command of a closed attempt has the effect ID in its command ID and the lease generation of the attempt", () => {
  const base = {
    kind: "record-outcome",
    commandId: "outcome:effect-1",
    runId: "run-1",
    operationId: operationOf(1),
    leaseGeneration: 2,
  };
  const given = { receipt: "receipt-1", worker: "worker-2" };
  assert.deepEqual(outcomeCommand({ ...attempt, outcome: "accepted" }), {
    ...base,
    ...given,
    outcome: "accepted",
  });
  assert.deepEqual(outcomeCommand({ ...attempt, outcome: "withheld" }), {
    ...base,
    outcome: "not-started",
    reason: "withheld",
  });
  assert.deepEqual(outcomeCommand({ ...attempt, outcome: "refused" }), {
    ...base,
    outcome: "not-started",
    reason: "budget-exhausted",
  });
  assert.deepEqual(
    [
      outcomeCommand({ ...attempt, outcome: "failed", reason: "tool-exit" }),
      outcomeCommand({ ...attempt, outcome: "stopped" }),
      outcomeCommand({ ...attempt, outcome: "unknown", reason: "time-limit" }),
      outcomeCommand({ ...attempt, outcome: "completed", result: "the text" }),
      outcomeCommand({
        ...attempt,
        outcome: "completed",
        reason: "result-too-large",
      }),
    ],
    [
      { ...base, ...given, outcome: "failed", reason: "tool-exit" },
      { ...base, ...given, outcome: "stopped" },
      { ...base, outcome: "unknown", reason: "time-limit" },
      { ...base, ...given, outcome: "completed", result: digestOf("the text") },
      { ...base, ...given, outcome: "completed", reason: "result-too-large" },
    ],
  );
  assert.deepEqual(
    outcomeCommand({
      ...attempt,
      outcome: "stopped",
      receipt: null,
      worker: null,
    }),
    { ...base, outcome: "stopped" },
  );
});

await test("CLV-066 the outcome command and the documents of a failed attempt keep its result", () => {
  const failed = {
    ...attempt,
    outcome: "failed",
    reason: "tool-exit",
    result: "the text",
  };
  assert.deepEqual(outcomeCommand(failed), {
    kind: "record-outcome",
    commandId: "outcome:effect-1",
    runId: "run-1",
    operationId: operationOf(1),
    leaseGeneration: 2,
    outcome: "failed",
    reason: "tool-exit",
    result: digestOf("the text"),
    receipt: "receipt-1",
    worker: "worker-2",
  });
  assert.deepEqual(
    [
      resultDocuments(failed),
      resultDocuments({ ...failed, outcome: "stopped" }),
      resultDocuments({ ...failed, result: null }),
    ],
    [[{ digest: digestOf("the text"), body: "the text" }], [], []],
  );
});

await test("CLV-049 the outcome command of an attempt with no known outcome is unknown, and a reconciliation that finds no effect gives not-started only for an operation with no stored receipt", () => {
  const base = {
    kind: "record-outcome",
    commandId: "outcome:effect-1",
    runId: "run-1",
    operationId: operationOf(1),
    leaseGeneration: 2,
  };
  assert.deepEqual(
    [
      outcomeCommand({ ...attempt, outcome: "thrown" }),
      outcomeCommand({ ...attempt, outcome: "unknown" }),
      outcomeCommand({ ...attempt, outcome: "absent" }),
      outcomeCommand({ ...attempt, outcome: "absent", storedReceipt: "r-1" }),
      outcomeCommand({ ...attempt, outcome: "stale-epoch" }),
    ],
    [
      { ...base, outcome: "unknown", reason: "handler-failure" },
      { ...base, outcome: "unknown", reason: "adapter-unknown" },
      { ...base, outcome: "not-started", reason: "absent" },
      { ...base, outcome: "unknown", reason: "absent-with-receipt" },
      { ...base, outcome: "unknown", reason: "stale-epoch" },
    ],
  );
  const reconcile = { ...attempt, purpose: "reconcile" };
  assert.equal(
    outcomeCommand({ ...reconcile, outcome: "withheld" }),
    undefined,
  );
  for (const outcome of ["blocked", "sent"])
    assert.equal(outcomeCommand({ ...attempt, outcome }), undefined, outcome);
});
