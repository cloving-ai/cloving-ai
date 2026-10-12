import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectState } from "../src/authority/operations.ts";
import {
  effectChecks,
  effectInputDigest,
  effectRows,
  storedEffects,
} from "../src/broker/effect-restore.ts";
import { digestOf } from "./digest-fixture.ts";
import { inputDigest } from "./effect-fixture.ts";
import {
  admission,
  applied,
  grant,
  operationOf,
  request,
  running,
  started,
} from "./effect-pure-fixture.ts";

function stopReport(runId: string): Readonly<Record<string, unknown>> {
  return {
    kind: "report-observation",
    runId,
    commandId: `c-stop-${runId}`,
    condition: "stopped",
    reason: "worker-exit",
    operationId: `["cloving-operation",0,"${runId}","admission","start-run",null,null]`,
  };
}

await test("CLV-049 the effect rows have a fixed order: budgets by run, operations by request sequence, leases and stops by key", () => {
  const { effects } = applied([
    admission,
    started,
    { ...admission, commandId: "c-admit-0", runId: "run-0" },
    { ...started, commandId: "c-start-0", runId: "run-0" },
    request(1, { resource: "z-key" }),
    request(2, { resource: "a-key" }),
    grant({ round: 1, generation: 1 }),
    grant({ round: 2, generation: 1 }),
    stopReport("run-0"),
    stopReport("run-1"),
  ]).state;
  const rows = effectRows(
    {
      ...effects,
      operations: Object.fromEntries(
        Object.entries(effects.operations).reverse(),
      ),
    },
    [],
  );
  assert.deepEqual(
    [
      rows.budgets.map((row) => row.runId),
      rows.operations.map((row) => row.operationId),
      rows.leases.map((row) => row.resourceKey),
      rows.stops.map((row) => [row.runId, row.sequence]),
    ],
    [
      ["run-0", "run-1"],
      [operationOf(1), operationOf(2)],
      ["a-key", "z-key"],
      [
        ["run-0", 9],
        ["run-1", 10],
      ],
    ],
  );
  assert.deepEqual(storedEffects({ ...rows, holding: 2 }), effects);
});

await test("CLV-049 the opening check refuses a count of holding operations that differs from the stored rows", () => {
  const { effects } = applied(running).state;
  const rows = effectRows(effects, []);
  const failed = (replayed: EffectState): readonly string[] =>
    effectChecks(rows, { effects: replayed, evidence: [] })
      .filter(([, holds]) => !holds)
      .map(([part]) => part);
  assert.deepEqual(failed(effects), ["input-digests"]);
  assert.deepEqual(failed({ ...effects, holding: 2 }), [
    "holding",
    "input-digests",
  ]);
});

await test("CLV-049 the input digest of a protected effect covers the capability, the method, the target and the payload", () => {
  const effect = {
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: digestOf("build the package"),
  };
  assert.equal(effectInputDigest(effect), inputDigest(effect));
  const digests = new Set(
    [
      effect,
      { ...effect, capability: "other" },
      { ...effect, method: "stop-turn" },
      { ...effect, target: "workspace/other" },
      { ...effect, payload: digestOf("a different text") },
    ].map(effectInputDigest),
  );
  assert.equal(digests.size, 5);
});

await test("CLV-049 the stored effect rows give the effect state again, and a row with an unknown status or lease state is refused", () => {
  const { effects } = applied(running).state;
  const rows = effectRows(effects, []);
  assert.deepEqual(storedEffects({ ...rows, holding: 1 }), effects);
  const [operation] = rows.operations;
  const [lease] = rows.leases;
  assert.ok(operation);
  assert.ok(lease);
  assert.throws(
    () =>
      storedEffects({
        ...rows,
        holding: 1,
        operations: [{ ...operation, status: "sent" }],
      }),
    /invalid-operation-row/,
  );
  assert.throws(
    () =>
      storedEffects({
        ...rows,
        holding: 1,
        leases: [{ ...lease, state: "free" }],
      }),
    /invalid-lease-row/,
  );
  assert.throws(
    () =>
      storedEffects({
        ...rows,
        holding: 1,
        budgets: rows.budgets.map((budget) => ({
          ...budget,
          capabilities: "{}",
        })),
      }),
    /invalid-budget-row/,
  );
});
