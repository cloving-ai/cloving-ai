import assert from "node:assert/strict";
import { test } from "node:test";
import { opening } from "./command-wait-fixture.ts";
import { rebuild, execute } from "../src/authority/reducer.ts";
import {
  checkRequest,
  waitLedger,
  beginCheck,
  checkReport,
  key,
  start,
} from "./command-wait-check-fixture.ts";

await test("CLV-236 120 checks settle outside the ordinary effect budget", () => {
  const ledger = waitLedger();
  ledger.ordinary(1);
  for (let check = 1; check <= 121; check += 1) {
    const operationId = beginCheck(ledger);
    ledger.at(ledger.now() + 1);
    const output = JSON.stringify(
      check <= 120
        ? { ready: false }
        : { ready: true, value: { approved: true } },
    );
    ledger.accept(checkReport(operationId, output));
    assert.equal(ledger.state().effects.budgets["run-1"]?.spent, 1);
    ledger.at(ledger.now() + 3_600_000);
  }
  const state = ledger.state();
  assert.equal(state.commandWaits?.[key]?.checkCount, 121);
  assert.equal(state.commandWaits[key]?.state, "completed");
  assert.equal(
    state.commandWaits[key]?.result,
    JSON.stringify({ approved: true }),
  );
  ledger.ordinary(2);
  assert.equal(ledger.state().effects.budgets["run-1"]?.spent, 2);
  assert.equal(ledger.ordinary(3).disposition?.disposition, "refused");
  assert.deepEqual(
    rebuild(ledger.events).commandWaits,
    ledger.state().commandWaits,
  );
});

await test("CLV-236 checks run when ordinary effects have already been refused", () => {
  const ledger = waitLedger({ opening: "deferred" });
  ledger.ordinary(1);
  ledger.ordinary(2);
  ledger.ordinary(3);
  ledger.accept(opening);
  const operationId = beginCheck(ledger);
  ledger.accept(checkReport(operationId, '{"ready":true}'));
  assert.equal(ledger.state().commandWaits?.[key]?.result, "null");
  assert.equal(ledger.state().effects.budgets["run-1"]?.spent, 2);
});

await test("CLV-236 checks never overlap and the next interval starts at settlement", () => {
  const ledger = waitLedger();
  const operationId = beginCheck(ledger);
  assert.deepEqual(ledger.send(checkRequest), {
    kind: "rejected",
    reason: "command-wait-check-in-flight",
  });
  ledger.at(start + 30_000);
  ledger.accept(checkReport(operationId, '{"ready":false}'));
  const next = start + 30_000 + 3_600_000;
  assert.equal(
    ledger.state().commandWaits?.[key]?.lastCheckSettledAt,
    start + 30_000,
  );
  assert.equal(ledger.state().commandWaits?.[key]?.nextCheckAt, next);
  ledger.at(next - 1);
  assert.deepEqual(ledger.send(checkRequest), {
    kind: "rejected",
    reason: "command-wait-check-not-due",
  });
  ledger.at(next);
  const second = beginCheck(ledger);
  assert.notEqual(second, operationId);
});

await test("CLV-236 thirty days admit at most 720 hourly checks", () => {
  const ledger = waitLedger();
  for (let check = 0; check < 720; check += 1) {
    const operationId = beginCheck(ledger);
    ledger.accept(checkReport(operationId, '{"ready":false}'));
    ledger.at(ledger.now() + 3_600_000);
  }
  assert.deepEqual(ledger.send(checkRequest), {
    kind: "rejected",
    reason: "command-wait-timeout",
  });
  ledger.accept({
    kind: "expire-command-wait",
    runId: "run-1",
    waitName: "team-review",
  });
  assert.equal(ledger.state().commandWaits?.[key]?.checkCount, 720);
  assert.equal(
    ledger.state().commandWaits?.[key]?.reason,
    "command-wait-timeout",
  );
});

await test("CLV-236 check admission refuses an unknown wait and an invalid authority clock", () => {
  const ledger = waitLedger();
  assert.deepEqual(ledger.send({ ...checkRequest, waitName: "absent" }), {
    kind: "rejected",
    reason: "unknown-command-wait",
  });
  assert.deepEqual(
    execute(ledger.state(), {
      command: { ...checkRequest, commandId: "bad-check-clock" },
      recordedAt: "invalid",
    }),
    { kind: "rejected", reason: "invalid-recorded-time" },
  );
});

for (const kind of ["pause-run", "complete-run", "fail-run", "cancel-run"])
  await test(`CLV-236 ${kind} admits no further check`, () => {
    const ledger = waitLedger();
    ledger.accept({ kind, runId: "run-1", expectedRevision: 2 });
    assert.deepEqual(ledger.send(checkRequest), {
      kind: "rejected",
      reason: "command-wait-run-not-running",
    });
    assert.equal(ledger.state().commandWaits?.[key]?.checkCount, 0);
  });

await test("CLV-236 a conflicting stored operation cannot become a wait check", () => {
  const occupied = waitLedger();
  const operationId = beginCheck(occupied);
  const ledger = waitLedger();
  const state = ledger.state();
  const existing = occupied.state().effects.operations[operationId];
  assert.ok(existing);
  const result = execute(
    {
      ...state,
      effects: { ...state.effects, operations: { [operationId]: existing } },
    },
    { command: checkRequest, recordedAt: new Date(start).toISOString() },
  );
  assert.deepEqual(result, {
    kind: "rejected",
    reason: "command-wait-operation-conflict",
  });
});
