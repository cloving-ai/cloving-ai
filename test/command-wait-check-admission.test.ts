import { commandLimits } from "../src/command-settings.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { oversized, json } from "../src/broker/actor/authority-receipts.ts";
import {
  librarySettings,
  authorityTiming,
} from "../src/broker/actor/authority-settings.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionManifest } from "../src/workflow-admission.ts";
import { admitted } from "../src/broker/authority-admission.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { operationIdentity } from "../src/operation-identity.ts";
import { pinned } from "./command-wait-fixture.ts";
import {
  checkRequest,
  waitLedger,
  beginCheck,
  checkReport,
  key,
  fields,
  inputDigest,
} from "./command-wait-check-fixture.ts";
import { request } from "./effect-pure-fixture.ts";

function admission(command: unknown, declaration: ExecutionManifest = pinned) {
  const state = waitLedger().state();
  const run = state.runs["run-1"];
  assert.ok(run);
  const pin = workflowPin(declaration);
  return admitted(
    { ...state, runs: { "run-1": { ...run, workflow: pin } } },
    {
      command,
      definitions: new Map([[pin, declaration]]),
      manifest: undefined,
    },
  );
}

await test("CLV-236 checks require the declared durable wait and its exact effect digest", () => {
  assert.equal(admission(checkRequest).kind, "admissible");
  for (const command of [
    { ...checkRequest, waitName: "undeclared" },
    { ...checkRequest, inputDigest: `sha256:${"a".repeat(64)}` },
  ])
    assert.equal(admission(command).kind, "rejected");
  assert.equal(
    admission(checkRequest, { ...pinned, commandWaits: {} }).kind,
    "rejected",
  );
});

await test("CLV-236 an ordinary request cannot reserve a future wait operation or borrow zero units", () => {
  const ledger = waitLedger();
  const identity = operationIdentity({
    run: "run-1",
    phase: "command-wait",
    operation: "team-review",
    round: 1,
  });
  assert.equal(identity.kind, "valid");
  const command = {
    ...request(1),
    ...fields,
    inputDigest,
    operationId: identity.value,
  };
  assert.equal(ledger.send(command).kind, "rejected");
  assert.equal(ledger.send({ ...checkRequest, units: 0 }).kind, "rejected");
  assert.equal(
    ledger.send({ ...checkRequest, capability: "command" }).kind,
    "rejected",
  );
  assert.equal(ledger.state().effects.budgets["run-1"]?.spent, 0);
});

await test("CLV-236 refusing an ordinary effect cannot cancel an admitted wait check", () => {
  const ledger = waitLedger();
  ledger.ordinary(1);
  ledger.ordinary(2);
  ledger.accept(checkRequest);
  const operationId = ledger.state().commandWaits?.[key]?.checkOperation;
  assert.ok(operationId);
  ledger.ordinary(3);
  assert.equal(
    ledger.state().effects.operations[operationId]?.status,
    "waiting",
  );
});

await test("CLV-236 wait output is bound to the reported result document", () => {
  const ledger = waitLedger();
  const operationId = beginCheck(ledger);
  const state = ledger.state();
  const command = {
    ...checkReport(operationId, '{"ready":true}'),
    result: `sha256:${"a".repeat(64)}`,
  };
  assert.equal(
    admitted(state, {
      command: { ...command, commandId: "forged-report" },
      definitions: new Map(),
      manifest: undefined,
    }).kind,
    "rejected",
  );
});

await test("CLV-236 a check refused before dispatch is terminal while a withheld check keeps its allowance", () => {
  for (const reason of ["budget-exhausted", "withheld"]) {
    const ledger = waitLedger();
    ledger.ordinary(1);
    ledger.ordinary(2);
    ledger.ordinary(3);
    ledger.accept(checkRequest);
    const operationId = ledger.state().commandWaits?.[key]?.checkOperation;
    assert.ok(operationId);
    ledger.accept({
      kind: "grant-lease",
      runId: "run-1",
      operationId,
      leaseGeneration: 1,
      expiresAt: new Date(ledger.now() + 60_000).toISOString(),
      capacity: 4,
    });
    ledger.accept({
      kind: "record-outcome",
      runId: "run-1",
      operationId,
      leaseGeneration: 1,
      outcome: "not-started",
      reason,
    });
    assert.equal(
      ledger.state().effects.operations[operationId]?.status,
      reason === "withheld" ? "waiting" : "cancelled",
    );
  }
});

await test("CLV-236 the maximum escaped command output fits report admission and the actor transport", () => {
  const output = "\u0000".repeat(commandLimits.stdoutBytes);
  const report = json({
    command: {
      kind: "report-effect",
      worker: "command",
      result: documentDigest(output),
      commandOutput: output,
    },
    documents: [output],
  });
  assert.equal(oversized(report), false);
  const settings = librarySettings(authorityTiming, undefined);
  assert.ok(
    Buffer.byteLength(JSON.stringify(report)) <=
      (settings.maxPayloadBytes ?? 0),
  );
});
