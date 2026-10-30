import assert from "node:assert/strict";
import {
  emptyAuthority,
  execute,
  type AuthorityEvent,
  type AuthorityState,
} from "../src/authority/reducer.ts";
import { commandWaitKey } from "../src/authority/command-waits.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { context, opening, pinned } from "./command-wait-fixture.ts";
import { request, type Fields } from "./effect-pure-fixture.ts";

export const key = commandWaitKey("run-1", "team-review");
export const start = Date.parse(context.recordedAt);
export const fields = {
  capability: "command",
  method: "run:review-state",
  target: "review-state",
  payload: opening.payload,
};
export const inputDigest = effectInputDigest(fields);
export const checkRequest = {
  kind: "check-command-wait",
  runId: "run-1",
  commandId: "check",
  waitName: "team-review",
  inputDigest,
};

export function waitLedger(options: { readonly opening?: "deferred" } = {}) {
  let state: AuthorityState = emptyAuthority;
  let now = start;
  let identifier = 0;
  const events: AuthorityEvent[] = [];
  function send(command: Fields) {
    identifier += 1;
    const result = execute(state, {
      command: { ...command, commandId: `wait-test-${String(identifier)}` },
      recordedAt: new Date(now).toISOString(),
    });
    if (result.kind === "accepted") {
      state = result.state;
      events.push(...result.events);
    }
    return result;
  }
  function accept(command: Fields) {
    const result = send(command);
    if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
    return result;
  }
  accept({
    kind: "admit-run",
    runId: "run-1",
    workflow: "pin-1",
    effectLimit: 2,
    capabilities: JSON.stringify(pinned.capabilities),
  });
  accept({ kind: "mark-started", runId: "run-1", expectedRevision: 1 });
  if (options.opening !== "deferred") accept(opening);
  return {
    state: () => state,
    events,
    now: () => now,
    at: (time: number) => {
      now = time;
    },
    send,
    accept,
    ordinary: (round: number) =>
      accept({ ...request(round), ...fields, inputDigest }),
  };
}

export type WaitLedger = ReturnType<typeof waitLedger>;

export function beginCheck(ledger: WaitLedger): string {
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
    outcome: "accepted",
    receipt: "receipt",
    worker: "command",
  });
  return operationId;
}

export function checkReport(
  operationId: string,
  commandOutput: string,
): Fields {
  return {
    kind: "report-effect",
    runId: "run-1",
    operationId,
    inputDigest,
    leaseGeneration: 1,
    worker: "command",
    outcome: "completed",
    result: documentDigest(commandOutput),
    commandOutput,
  };
}
