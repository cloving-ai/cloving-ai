import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleIntents } from "../src/authority/reducer.ts";
import {
  admission,
  applied,
  grant,
  later,
  letters,
  noon,
  operationOf,
  operation,
  rejection,
  request,
  started,
} from "./effect-pure-fixture.ts";

const first = operationOf(1);

await test("CLV-049 a request for a protected effect is admitted as a waiting operation, and its units are spent", () => {
  const { state, last } = applied([admission, started, request(1)]);
  assert.deepEqual(state.effects.operations[first], {
    runId: "run-1",
    operationId: first,
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: letters("a"),
    inputDigest: letters("b"),
    units: 1,
    leaseKey: first,
    recoveryLimit: 3,
    status: "waiting",
    reason: "ready",
    attempts: 0,
    receipt: null,
    worker: null,
    result: null,
    requestedSequence: 3,
    waitSequence: 3,
    settledSequence: null,
  });
  assert.deepEqual(state.effects.budgets["run-1"], {
    runId: "run-1",
    limit: 3,
    spent: 1,
    capabilities: ["fake-harness"],
    exhaustedSequence: null,
  });
  assert.deepEqual(last.disposition, {
    operationId: first,
    disposition: "admitted",
    reason: null,
  });
  assert.deepEqual([last.intents, state.effects.holding], [[], 0]);
  assert.deepEqual(
    [state.runs["run-1"]?.status, state.runs["run-1"]?.revision],
    ["running", 2],
  );
});

await test("CLV-049 a lease grant gives the operation the status dispatch-pending, the first generation of its key and one protected intent", () => {
  const { state, last } = applied([
    admission,
    started,
    request(1),
    grant({ round: 1, generation: 1 }),
  ]);
  const operation = state.effects.operations[first];
  assert.deepEqual(
    [operation?.status, operation?.reason, operation?.waitSequence],
    ["dispatch-pending", null, null],
  );
  assert.deepEqual(state.effects.leases[first], {
    resourceKey: first,
    operationId: first,
    generation: 1,
    expiresAt: later,
    state: "held",
    grantedSequence: 4,
  });
  const intent = {
    kind: "protected-effect",
    runId: "run-1",
    operationId: first,
  };
  assert.deepEqual(last.intents, [intent]);
  assert.deepEqual(eligibleIntents(state), [intent]);
  assert.deepEqual(
    [
      state.effects.holding,
      state.details["run-1"]?.generation,
      state.runs["run-1"]?.revision,
    ],
    [1, 1, 2],
  );
});

await test("CLV-049 a request for an unknown run, a run that did not start, a terminal run, a different run scope or a changed input is rejected and changes nothing", () => {
  const running = applied([admission, started, request(1)]).state;
  const queued = applied([admission]).state;
  const complete = { kind: "complete-run", commandId: "c-end", runId: "run-1" };
  const ended = applied([{ ...complete, expectedRevision: 2 }], running).state;
  assert.equal(
    rejection(running, request(2, { runId: "run-9" })),
    "unknown-run",
  );
  assert.equal(rejection(queued, request(1)), "run-not-running");
  assert.equal(rejection(ended, request(2)), "terminal-run");
  assert.equal(
    rejection(running, request(2, { operationId: operationOf(2, "run-2") })),
    "operation-scope-mismatch",
  );
  for (const operationId of [
    "not an identity",
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
    '["cloving-operation",4,"run-1","gate","continue-run",null,"gate-1"]',
  ])
    assert.equal(
      rejection(running, request(2, { operationId })),
      "operation-scope-mismatch",
      operationId,
    );
  for (const changed of [
    { target: "workspace/other" },
    { payload: letters("c") },
    { inputDigest: letters("c") },
    { units: 2 },
    { resource: "repository" },
    { capability: "other" },
    { method: "other" },
  ])
    assert.equal(
      rejection(running, request(1, { commandId: "c-again", ...changed })),
      "changed-operation-input",
      JSON.stringify(changed),
    );
});

await test("CLV-049 a second request for a known operation with equal input is recorded as existing and spends no unit", () => {
  const before = applied([admission, started, request(1)]).state;
  const { state, last } = applied(
    [request(1, { commandId: "c-retry", transport: "sdk retry 2" })],
    before,
  );
  assert.deepEqual(last.disposition, {
    operationId: first,
    disposition: "existing",
    reason: null,
  });
  assert.deepEqual(state.effects, before.effects);
  assert.deepEqual(last.intents, []);
  assert.equal(last.events[0]?.payload["transport"], "sdk retry 2");
});

await test("CLV-049 a new operation waits with the reason of its wait: a resource with an owner, or a run that is not running", () => {
  const shared = { resource: "repository" };
  const held = applied([
    admission,
    started,
    request(1, shared),
    grant({ round: 1, generation: 1 }),
    request(2, shared),
  ]).state;
  assert.deepEqual(
    [
      held.effects.operations[operationOf(2)]?.reason,
      held.effects.operations[operationOf(2)]?.leaseKey,
      held.effects.leases["repository"]?.operationId,
    ],
    ["resource", "repository", first],
  );
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-1" };
  const paused = applied([
    admission,
    started,
    { ...pause, expectedRevision: 2 },
    request(1),
  ]).state;
  assert.equal(paused.effects.operations[first]?.reason, "run-not-running");
  const gate = { kind: "open-gate", commandId: "c-gate", runId: "run-1" };
  const waiting = applied([
    admission,
    started,
    { ...gate, gateId: "gate-1", expectedRevision: 2 },
    request(1),
  ]).state;
  assert.equal(waiting.effects.operations[first]?.reason, "run-not-running");
});

await test("CLV-049 a lease grant is rejected for an unknown operation, a wrong generation, a full capacity, a key with an owner, a run that is not running, an operation that does not wait and an expiry that is not later", () => {
  const shared = { resource: "repository" };
  const waiting = applied([admission, started, request(1, shared)]).state;
  const one = { round: 1, generation: 1 };
  assert.equal(
    rejection(waiting, grant({ round: 7, generation: 1 })),
    "unknown-operation",
  );
  assert.equal(
    rejection(waiting, grant({ round: 1, generation: 2 })),
    "stale-lease-generation",
  );
  assert.equal(
    rejection(waiting, grant(one, { expiresAt: noon })),
    "invalid-lease-expiry",
  );
  const granted = applied(
    [grant(one), request(2, shared), request(3)],
    waiting,
  );
  assert.equal(
    rejection(granted.state, grant({ round: 2, generation: 2 })),
    "resource-held",
  );
  assert.equal(
    rejection(
      granted.state,
      grant({ round: 3, generation: 1 }, { capacity: 1 }),
    ),
    "capacity-exceeded",
  );
  assert.equal(
    rejection(granted.state, grant(one, { commandId: "c-again" })),
    "operation-not-waiting",
  );
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-1" };
  const paused = applied([{ ...pause, expectedRevision: 2 }], granted.state);
  assert.equal(
    rejection(paused.state, grant({ round: 3, generation: 1 })),
    "run-not-running",
  );
});

await test("CLV-049 a request with a capability that the run did not pin or with no unit is recorded as refused and spends nothing", () => {
  const base = applied([admission, started, request(1)]).state;
  const capability = applied([request(2, { capability: "other" })], base);
  assert.deepEqual(capability.last.disposition, {
    operationId: operationOf(2),
    disposition: "refused",
    reason: "unadmitted-capability",
  });
  const refused = operation(capability.state, 2);
  assert.deepEqual(
    [refused.status, refused.reason, refused.waitSequence],
    ["refused", "unadmitted-capability", null],
  );
  assert.equal(capability.state.effects.budgets["run-1"]?.spent, 1);
  assert.equal(operation(capability.state).status, "waiting");
  const empty = applied([request(2, { units: 0 })], base);
  assert.equal(empty.last.disposition?.reason, "invalid-effect-request");
});

await test("CLV-049 a request above the budget is recorded as refused, and an exhausted budget cancels each waiting operation and refuses each later request", () => {
  const base = applied([admission, started, request(1)]).state;
  const exhausted = applied([request(2, { units: 3 })], base);
  assert.equal(exhausted.last.disposition?.reason, "budget-exhausted");
  const waited = operation(exhausted.state);
  assert.deepEqual(
    [waited.status, waited.reason, waited.waitSequence, waited.settledSequence],
    ["cancelled", "budget-exhausted", null, 4],
  );
  assert.deepEqual(exhausted.state.effects.budgets["run-1"], {
    runId: "run-1",
    limit: 3,
    spent: 1,
    capabilities: ["fake-harness"],
    exhaustedSequence: 4,
  });
  const afterwards = applied([request(3)], exhausted.state);
  assert.deepEqual(
    [afterwards.last.disposition, operation(afterwards.state, 3).status],
    [
      {
        operationId: operationOf(3),
        disposition: "refused",
        reason: "budget-exhausted",
      },
      "refused",
    ],
  );
  const retry = request(2, { units: 3, commandId: "c-again" });
  const again = applied([retry], exhausted.state);
  assert.equal(again.last.disposition?.disposition, "existing");
});

await test("CLV-049 a run with no effect budget refuses each request with budget-exhausted", () => {
  const plain = {
    ...admission,
    effectLimit: undefined,
    capabilities: undefined,
  };
  const unbudgeted = applied([plain, started, request(1)]);
  assert.equal(unbudgeted.last.disposition?.reason, "budget-exhausted");
  assert.deepEqual(unbudgeted.state.effects.budgets, {});
  assert.equal(operation(unbudgeted.state).status, "refused");
});

await test("CLV-049 an exhausted budget cancels each waiting operation of the run and no operation that holds a lease, and a different refusal cancels nothing", () => {
  const granted = applied([
    admission,
    started,
    request(1),
    grant({ round: 1, generation: 1 }),
    request(2),
    request(3, { units: 3 }),
  ]).state;
  assert.deepEqual(
    [
      granted.effects.operations[first]?.status,
      granted.effects.operations[operationOf(2)]?.status,
      granted.effects.operations[operationOf(3)]?.status,
      granted.effects.holding,
    ],
    ["dispatch-pending", "cancelled", "refused", 1],
  );
  const fresh = applied([
    admission,
    started,
    request(1),
    request(2, { capability: "other" }),
  ]).state;
  assert.equal(fresh.effects.operations[first]?.status, "waiting");
});

await test("CLV-049 an exhausted budget of one run cancels no waiting operation of a different run", () => {
  const second = operationOf(1, "run-2");
  const { state } = applied([
    admission,
    started,
    { ...admission, commandId: "c-admit-2", runId: "run-2" },
    { ...started, commandId: "c-start-2", runId: "run-2" },
    request(1),
    request(1, { commandId: "c-other", runId: "run-2", operationId: second }),
    request(2, { units: 3 }),
  ]);
  assert.deepEqual(
    [
      operation(state).status,
      state.effects.operations[second]?.status,
      state.effects.budgets["run-2"]?.exhaustedSequence,
    ],
    ["cancelled", "waiting", null],
  );
});
