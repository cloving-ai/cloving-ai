import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admission,
  applied,
  appliedAt,
  later,
  operationOf,
  report,
  request,
  running,
  started,
} from "./effect-pure-fixture.ts";

const base = applied(running).state;

function child(extra: Readonly<Record<string, unknown>> = {}) {
  return request(2, {
    source: operationOf(1),
    sourceGeneration: 1,
    ...extra,
  });
}

await test("CLV-049 a request that names a source operation with a held lease of that generation is admitted", () => {
  const { state, last } = applied([child()], base);
  assert.equal(last.disposition?.disposition, "admitted");
  assert.equal(state.effects.operations[operationOf(2)]?.status, "waiting");
});

await test("CLV-049 a request from a source that does not own its lease at the named generation, or whose lease is expired, is denied: no operation is made and no unit is spent", () => {
  const settled = applied([report(1)], base).state;
  const expired = appliedAt(later, {
    steps: [
      {
        kind: "expire-lease",
        runId: "run-1",
        commandId: "c-expire",
        operationId: operationOf(1),
        leaseGeneration: 1,
      },
    ],
    start: base,
  }).state;
  for (const [name, denied, reason] of [
    [
      "a different generation",
      applied([child({ sourceGeneration: 2 })], base),
      "retired-lease-generation",
    ],
    [
      "an unknown source",
      applied([child({ source: operationOf(7) })], base),
      "retired-lease-generation",
    ],
    [
      "a released lease",
      applied([child()], settled),
      "retired-lease-generation",
    ],
    [
      "a lease at its expiry time",
      appliedAt(later, { steps: [child()], start: base }),
      "lease-expired",
    ],
    [
      "a lease with the state expired",
      appliedAt(later, { steps: [child()], start: expired }),
      "lease-expired",
    ],
  ] as const) {
    assert.deepEqual(
      denied.last.disposition,
      { operationId: operationOf(2), disposition: "denied", reason },
      name,
    );
    assert.equal(
      denied.state.effects.operations[operationOf(2)],
      undefined,
      name,
    );
    assert.equal(denied.state.effects.budgets["run-1"]?.spent, 1, name);
    assert.deepEqual(denied.last.intents, [], name);
  }
});

await test("CLV-049 a request whose source is an operation of a different run is denied: no operation is made and no unit is spent", () => {
  const second = applied(
    [
      { ...admission, runId: "run-2", commandId: "c-admit-2" },
      { ...started, runId: "run-2", commandId: "c-start-2" },
    ],
    base,
  ).state;
  const denied = applied(
    [
      child({
        runId: "run-2",
        commandId: "c-request-other",
        operationId: operationOf(2, "run-2"),
      }),
    ],
    second,
  );
  assert.deepEqual(denied.last.disposition, {
    operationId: operationOf(2, "run-2"),
    disposition: "denied",
    reason: "retired-lease-generation",
  });
  assert.equal(
    denied.state.effects.operations[operationOf(2, "run-2")],
    undefined,
  );
  assert.equal(denied.state.effects.budgets["run-2"]?.spent, 0);
});
