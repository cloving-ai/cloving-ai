import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eligibleIntents,
  type AuthorityState,
} from "../src/authority/reducer.ts";
import {
  accepted,
  admission,
  applied,
  appliedAt,
  grant,
  later,
  letters,
  operation,
  operationOf,
  outcome,
  rejection,
  report,
  request,
  running,
  started,
} from "./effect-pure-fixture.ts";

const first = operationOf(1);
const intent = { kind: "protected-effect", runId: "run-1", operationId: first };
const pending = [
  admission,
  started,
  request(1),
  grant({ round: 1, generation: 1 }),
];

await test("CLV-049 a recorded acceptance gives the operation the status running with its receipt and its worker, and it releases the intent", () => {
  const { state, last } = applied(running);
  const operation = state.effects.operations[first];
  assert.deepEqual(
    [
      operation?.status,
      operation?.receipt,
      operation?.worker,
      operation?.attempts,
    ],
    ["running", "receipt-1", "worker-1", 0],
  );
  assert.deepEqual(last.disposition, {
    operationId: first,
    disposition: "applied",
    reason: null,
  });
  assert.deepEqual([state.intents, state.effects.holding], [[], 1]);
  const again = applied(
    [accepted(1, 1)].map((command) => ({ ...command, commandId: "c-again" })),
    state,
  );
  assert.deepEqual(again.state.effects, state.effects);
});

await test("CLV-049 a report with the present lease generation after the recorded acceptance settles the operation and releases its lease", () => {
  const { state, last } = applied([...running, report(1)]);
  const operation = state.effects.operations[first];
  assert.deepEqual(
    [
      operation?.status,
      operation?.result,
      operation?.settledSequence,
      operation?.reason,
    ],
    ["completed", letters("d"), 6, null],
  );
  assert.deepEqual(state.effects.leases[first], {
    resourceKey: first,
    operationId: first,
    generation: 1,
    expiresAt: later,
    state: "released",
    grantedSequence: 4,
  });
  assert.equal(state.effects.holding, 0);
  assert.equal(last.disposition?.disposition, "applied");
  for (const [fields, status] of [
    [{ outcome: "failed", result: undefined, reason: "tool-exit" }, "failed"],
    [{ outcome: "stopped", result: undefined }, "stopped"],
  ] as const) {
    const settled = applied([...running, report(1, fields)]).state;
    assert.equal(settled.effects.operations[first]?.status, status);
    assert.equal(settled.effects.leases[first]?.state, "released");
  }
  assert.equal(
    applied([
      ...running,
      report(1, { outcome: "failed", result: undefined, reason: "tool-exit" }),
    ]).state.effects.operations[first]?.reason,
    "tool-exit",
  );
});

const notStarted = outcome(1, { outcome: "not-started", reason: "withheld" });

const regranted = [
  ...pending,
  notStarted,
  grant({ round: 1, generation: 2 }),
  accepted(1, 2),
];

await test("CLV-049 a report from a retired lease generation is recorded as rejected and changes no operation, no lease and no run", () => {
  const before = applied(regranted).state;
  assert.equal(before.effects.leases[first]?.generation, 2);
  const { state, last } = applied([report(1)], before);
  assert.deepEqual(last.disposition, {
    operationId: first,
    disposition: "rejected",
    reason: "retired-lease-generation",
  });
  assert.deepEqual(state.effects, before.effects);
  assert.deepEqual(state.runs, before.runs);
  assert.deepEqual(state.intents, before.intents);
  assert.equal(state.sequence, before.sequence + 1);
});

function reportReason(
  ledger: AuthorityState,
  fields: Readonly<Record<string, unknown>>,
): string | null {
  const { last } = applied(
    [report(1, { commandId: "c-late", ...fields })],
    ledger,
  );
  assert.ok(last.disposition);
  return last.disposition.reason;
}

await test("CLV-049 a report is rejected, in a fixed order, for a different input, a final operation, a lease that the operation does not own, an expired lease, no recorded acceptance and a different worker", () => {
  const state = applied(running).state;
  assert.equal(
    reportReason(state, { inputDigest: letters("c") }),
    "input-mismatch",
  );
  assert.equal(
    reportReason(state, { leaseGeneration: 2 }),
    "retired-lease-generation",
  );
  assert.equal(reportReason(state, { worker: "worker-9" }), "worker-mismatch");
  const settled = applied([report(1)], state).state;
  assert.equal(reportReason(settled, {}), "operation-settled");
  assert.equal(
    reportReason(applied(pending).state, {}),
    "acceptance-not-recorded",
  );
  const waiting = applied([admission, started, request(1)]).state;
  assert.equal(reportReason(waiting, {}), "retired-lease-generation");
  const expired = appliedAt(later, { steps: [report(1)], start: state });
  assert.deepEqual(
    [expired.last.disposition, expired.state.effects],
    [
      { operationId: first, disposition: "rejected", reason: "lease-expired" },
      state.effects,
    ],
  );
  assert.equal(
    rejection(state, report(2, { commandId: "c-unknown" })),
    "unknown-operation",
  );
});

await test("CLV-049 the outcome not-started makes the operation wait again with its intent", () => {
  const { state } = applied([...pending, notStarted]);
  const waiting = operation(state);
  assert.deepEqual(
    [waiting.status, waiting.reason, waiting.waitSequence],
    ["waiting", "ready", 5],
  );
  assert.deepEqual(
    [state.effects.leases[first]?.state, state.effects.holding],
    ["released", 0],
  );
  assert.deepEqual(state.intents, [intent]);
  assert.deepEqual(eligibleIntents(state), []);
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-1" };
  const paused = applied([
    ...pending,
    { ...pause, expectedRevision: 2 },
    notStarted,
  ]);
  assert.equal(operation(paused.state).reason, "run-not-running");
});

await test("CLV-049 the outcome not-started cancels the operation of a terminal run and of a run with an exhausted budget", () => {
  const drop = { kind: "cancel-run", commandId: "c-drop", runId: "run-1" };
  const dropped = applied([
    ...pending,
    { ...drop, expectedRevision: 2 },
    notStarted,
  ]);
  const cancelled = operation(dropped.state);
  assert.deepEqual(
    [cancelled.status, cancelled.reason, cancelled.settledSequence],
    ["cancelled", "withheld", 6],
  );
  assert.deepEqual(dropped.state.intents, []);
  assert.equal(dropped.state.effects.holding, 0);
  const exhausted = applied([...pending, request(2, { units: 3 }), notStarted]);
  const refused = operation(exhausted.state);
  assert.deepEqual(
    [refused.status, refused.reason],
    ["cancelled", "budget-exhausted"],
  );
  const recheck = outcome(1, {
    outcome: "not-started",
    reason: "budget-exhausted",
  });
  const withheld = operation(applied([...pending, recheck]).state);
  assert.deepEqual(
    [withheld.status, withheld.reason],
    ["cancelled", "budget-exhausted"],
  );
  const silent = applied([
    ...pending,
    { ...drop, expectedRevision: 2 },
    outcome(1, { outcome: "not-started" }),
  ]);
  assert.equal(operation(silent.state).reason, "not-started");
});

await test("CLV-049 an unknown outcome adds to the attempts and keeps the lease, and the operation is blocked at its recovery limit", () => {
  const unknown = (name: string) =>
    outcome(1, { outcome: "unknown", reason: "time-limit", commandId: name });
  const once = applied([...pending, unknown("c-u1")]).state;
  const operation = once.effects.operations[first];
  assert.deepEqual(
    [operation?.status, operation?.reason, operation?.attempts],
    ["recovering", "outcome-unknown", 1],
  );
  assert.deepEqual(
    [once.effects.leases[first]?.state, once.effects.holding],
    ["held", 1],
  );
  const thrice = applied([unknown("c-u2"), unknown("c-u3")], once).state;
  assert.deepEqual(
    [
      thrice.effects.operations[first]?.status,
      thrice.effects.operations[first]?.attempts,
    ],
    ["blocked", 3],
  );
  const known = applied([accepted(1)], thrice).state.effects.operations[first];
  assert.deepEqual([known?.status, known?.attempts], ["running", 3]);
});

await test("CLV-049 a rejected outcome of a final operation changes nothing, and an outcome of a retired generation or of a different worker adds to the attempts", () => {
  const settled = applied([...running, report(1)]).state;
  const late = applied([{ ...accepted(1), commandId: "c-late" }], settled);
  assert.equal(late.last.disposition?.reason, "operation-settled");
  assert.deepEqual(late.state.effects, settled.effects);
  const state = applied(running).state;
  for (const [fields, reason] of [
    [{ leaseGeneration: 2 }, "retired-lease-generation"],
    [{ worker: "worker-9" }, "worker-mismatch"],
  ] as const) {
    const completed = { outcome: "completed", result: letters("d"), ...fields };
    const rejected = applied([outcome(1, completed)], state);
    assert.deepEqual(rejected.last.disposition, {
      operationId: first,
      disposition: "rejected",
      reason,
    });
    const counted = operation(rejected.state);
    assert.deepEqual([counted.attempts, counted.status], [1, "running"]);
  }
});

await test("CLV-049 an acceptance with no receipt or no worker, and the outcome not-started for an operation with a receipt, are rejected and add to the attempts", () => {
  const incomplete = applied(
    [outcome(1, { outcome: "accepted", receipt: "receipt-9" })],
    applied(pending).state,
  );
  assert.equal(incomplete.last.disposition?.reason, "invalid-outcome");
  const unbound = operation(incomplete.state);
  assert.deepEqual(
    [unbound.attempts, unbound.status, unbound.receipt],
    [1, "dispatch-pending", null],
  );
  const absent = outcome(1, { outcome: "not-started", reason: "absent" });
  const receipt = applied([absent], applied(running).state);
  assert.equal(receipt.last.disposition?.reason, "acceptance-recorded");
  assert.deepEqual(
    [
      operation(receipt.state).attempts,
      receipt.state.effects.leases[first]?.state,
    ],
    [1, "held"],
  );
});

await test("CLV-049 an outcome that is known settles the operation from each holding status", () => {
  for (const [name, fields] of [
    ["completed", { result: letters("d") }],
    ["failed", { reason: "tool-exit" }],
    ["stopped", {}],
  ] as const) {
    const direct = applied([
      ...pending,
      outcome(1, { outcome: name, ...fields }),
    ]);
    const operation = direct.state.effects.operations[first];
    assert.deepEqual(
      [
        operation?.status,
        direct.state.effects.holding,
        direct.state.intents.length,
      ],
      [name, 0, 0],
      name,
    );
    assert.equal(direct.state.effects.leases[first]?.state, "released");
  }
});

await test("CLV-049 a known outcome keeps the receipt and the worker of an earlier acceptance, and an operation with no acceptance gets them from the outcome", () => {
  const given = { receipt: "receipt-late", worker: "worker-late" };
  const settlement = outcome(1, {
    outcome: "completed",
    result: letters("d"),
    ...given,
  });
  const direct = operation(applied([...pending, settlement]).state);
  assert.deepEqual(
    [direct.status, direct.receipt, direct.worker],
    ["completed", "receipt-late", "worker-late"],
  );
  const plain = operation(
    applied([...pending, outcome(1, { outcome: "stopped" })]).state,
  );
  assert.deepEqual([plain.receipt, plain.worker], [null, null]);
  const kept = operation(
    applied([
      ...pending,
      accepted(1),
      outcome(1, { outcome: "failed", reason: "tool-exit", receipt: "r-2" }),
    ]).state,
  );
  assert.deepEqual(
    [kept.status, kept.receipt, kept.worker],
    ["failed", "receipt-1", "worker-1"],
  );
});

await test("CLV-049 a later acceptance keeps the receipt and the worker that the operation has", () => {
  const again = outcome(1, {
    outcome: "accepted",
    receipt: "receipt-2",
    worker: "worker-1",
    commandId: "c-accepted-again",
  });
  const repeated = operation(applied([...pending, accepted(1), again]).state);
  assert.deepEqual(
    [repeated.status, repeated.receipt, repeated.worker],
    ["running", "receipt-1", "worker-1"],
  );
});
