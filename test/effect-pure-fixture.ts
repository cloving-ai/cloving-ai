import assert from "node:assert/strict";
import type { Operation } from "../src/authority/operations.ts";
import {
  emptyAuthority,
  execute,
  type AuthorityState,
  type CommandResult,
} from "../src/authority/reducer.ts";

export type Fields = Readonly<Record<string, unknown>>;

export const noon = "2026-10-10T12:00:00.000Z";
export const later = "2026-10-10T12:10:00.000Z";

export function letters(letter: string): string {
  return `sha256:${letter.repeat(64)}`;
}

export const admission = {
  kind: "admit-run",
  commandId: "c-admit",
  runId: "run-1",
  workflow: "pin-1",
  effectLimit: 3,
  capabilities: '["fake-harness"]',
};

export const started = {
  kind: "mark-started",
  commandId: "c-start",
  runId: "run-1",
  expectedRevision: 1,
};

export function operationOf(round: number, runId = "run-1"): string {
  return JSON.stringify([
    "cloving-operation",
    round,
    runId,
    "work",
    "effect",
    null,
    null,
  ]);
}

export function request(round: number, extra: Fields = {}): Fields {
  return {
    kind: "request-effect",
    runId: "run-1",
    commandId: `c-request-${String(round)}`,
    operationId: operationOf(round),
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: letters("a"),
    inputDigest: letters("b"),
    units: 1,
    recoveryLimit: 3,
    ...extra,
  };
}

export function grant(
  lease: { readonly round: number; readonly generation: number },
  extra: Fields = {},
): Fields {
  const { round, generation } = lease;
  return {
    kind: "grant-lease",
    runId: "run-1",
    commandId: `c-grant-${String(round)}-${String(generation)}`,
    operationId: operationOf(round),
    leaseGeneration: generation,
    expiresAt: later,
    capacity: 4,
    ...extra,
  };
}

type Accepted = Extract<CommandResult, { kind: "accepted" }>;

export interface Ledger {
  readonly state: AuthorityState;
  readonly last: Accepted;
}

export function appliedAt(
  recordedAt: string,
  ledger: { readonly steps: readonly Fields[]; readonly start: AuthorityState },
): Ledger {
  let state = ledger.start;
  let last: Accepted | undefined;
  for (const command of ledger.steps) {
    const result = execute(state, { command, recordedAt });
    if (result.kind !== "accepted")
      throw new Error(JSON.stringify([command, result]));
    last = result;
    state = result.state;
  }
  assert.ok(last);
  return { state, last };
}

export function applied(
  steps: readonly Fields[],
  start: AuthorityState = emptyAuthority,
): Ledger {
  return appliedAt(noon, { steps, start });
}

export function rejection(state: AuthorityState, command: Fields): string {
  const result = execute(state, { command, recordedAt: noon });
  if (result.kind !== "rejected")
    throw new Error(JSON.stringify([command, result]));
  return result.reason;
}

export function operation(state: AuthorityState, round = 1): Operation {
  const found = state.effects.operations[operationOf(round)];
  assert.ok(found, `operation ${String(round)}`);
  return found;
}

export function outcome(round: number, fields: Fields): Fields {
  return {
    kind: "record-outcome",
    runId: "run-1",
    commandId: `c-outcome-${String(round)}-${String(fields["outcome"])}`,
    operationId: operationOf(round),
    leaseGeneration: 1,
    ...fields,
  };
}

export function accepted(round: number, generation = 1): Fields {
  return outcome(round, {
    outcome: "accepted",
    leaseGeneration: generation,
    receipt: `receipt-${String(round)}`,
    worker: `worker-${String(generation)}`,
    commandId: `c-accepted-${String(round)}-${String(generation)}`,
  });
}

export function report(round: number, fields: Fields = {}): Fields {
  return {
    kind: "report-effect",
    runId: "run-1",
    commandId: `c-report-${String(round)}`,
    operationId: operationOf(round),
    inputDigest: letters("b"),
    leaseGeneration: 1,
    worker: "worker-1",
    outcome: "completed",
    result: letters("d"),
    ...fields,
  };
}

export const running = [
  admission,
  started,
  request(1),
  grant({ round: 1, generation: 1 }),
  accepted(1),
];
