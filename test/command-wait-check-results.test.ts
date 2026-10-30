import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "../src/authority/reducer.ts";
import { opening } from "./command-wait-fixture.ts";
import {
  beginCheck,
  checkReport,
  checkRequest,
  key,
  start,
  waitLedger,
} from "./command-wait-check-fixture.ts";

for (const output of [
  "",
  "invalid",
  "null",
  "[]",
  "true",
  "{}",
  '{"ready":0}',
  '{"ready":"false"}',
])
  await test(`CLV-236 invalid check output fails without retry: ${output}`, () => {
    const ledger = waitLedger();
    const operationId = beginCheck(ledger);
    ledger.accept(checkReport(operationId, output));
    assert.equal(ledger.state().commandWaits?.[key]?.state, "failed");
    assert.equal(
      ledger.state().commandWaits?.[key]?.reason,
      "command-wait-invalid-output",
    );
    assert.equal(ledger.send(checkRequest).kind, "rejected");
    ledger.accept(opening);
    assert.equal(ledger.state().commandWaits?.[key]?.checkCount, 1);
  });

for (const reason of [
  "command-failed",
  "command-interrupted",
  "command-timeout",
])
  await test(`CLV-236 command failure ends the wait: ${reason}`, () => {
    const ledger = waitLedger();
    const operationId = beginCheck(ledger);
    ledger.accept({
      ...checkReport(operationId, '{"ready":true}'),
      outcome: "failed",
      reason,
    });
    assert.equal(ledger.state().commandWaits?.[key]?.state, "failed");
    assert.equal(ledger.state().commandWaits?.[key]?.reason, reason);
    assert.equal(ledger.state().commandWaits?.[key]?.result, null);
  });

for (const offset of [-1, 0, 1])
  await test(`CLV-236 readiness uses authority settlement time at deadline ${String(offset)}ms`, () => {
    const ledger = waitLedger();
    const deadline = start + 2_592_000_000;
    ledger.at(deadline - 1000);
    const operationId = beginCheck(ledger);
    const report = checkReport(
      operationId,
      '{"ready":true,"value":{"approved":true}}',
    );
    ledger.at(deadline + offset);
    ledger.accept(report);
    const wait = ledger.state().commandWaits?.[key];
    assert.equal(wait?.state, offset < 0 ? "completed" : "timed-out");
    assert.equal(wait.reason, offset < 0 ? null : "command-wait-timeout");
    assert.equal(wait.result, offset < 0 ? '{"approved":true}' : null);
  });

await test("CLV-236 a retired result cannot complete or reschedule a pending check", () => {
  const ledger = waitLedger();
  const first = beginCheck(ledger);
  ledger.accept(checkReport(first, '{"ready":false}'));
  ledger.at(start + 3_600_000);
  beginCheck(ledger);
  const before = ledger.state().commandWaits;
  const refused = ledger.accept(checkReport(first, '{"ready":true}'));
  assert.equal(refused.disposition?.reason, "operation-settled");
  assert.deepEqual(ledger.state().commandWaits, before);
});

await test("CLV-236 invalid authority time on a check result is refused without a throw", () => {
  const ledger = waitLedger();
  const operationId = beginCheck(ledger);
  assert.deepEqual(
    execute(ledger.state(), {
      command: {
        ...checkReport(operationId, '{"ready":true}'),
        commandId: "invalid-time",
      },
      recordedAt: "invalid",
    }),
    { kind: "rejected", reason: "invalid-recorded-time" },
  );
});
