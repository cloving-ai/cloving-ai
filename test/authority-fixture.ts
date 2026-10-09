import assert from "node:assert/strict";
import {
  emptyAuthority,
  execute,
  type AuthorityState,
} from "../src/authority/reducer.ts";

export const recorded = { recordedAt: "2026-10-09T00:00:00Z" };

export function run(
  commands: readonly Readonly<Record<string, unknown>>[],
): ReturnType<typeof execute>[] {
  let state = emptyAuthority;
  const results: ReturnType<typeof execute>[] = [];
  for (const command of commands) {
    const result = execute(state, command, recorded);
    results.push(result);
    if (result.kind === "accepted") state = result.state;
  }
  return results;
}

export function lastState(
  results: readonly ReturnType<typeof execute>[],
): AuthorityState {
  const accepted = results.filter((result) => result.kind === "accepted");
  const last = accepted.at(-1);
  assert.ok(last);
  return last.state;
}

export const admit = {
  kind: "admit-run",
  commandId: "c-1",
  runId: "run-1",
  workflow: "pin-1",
};

export const answeredGate = [
  admit,
  {
    kind: "mark-started",
    commandId: "c-2",
    runId: "run-1",
    expectedRevision: 1,
  },
  {
    kind: "open-gate",
    commandId: "c-3",
    runId: "run-1",
    gateId: "gate-1",
    expectedRevision: 2,
  },
  {
    kind: "decide-gate",
    commandId: "c-4",
    runId: "run-1",
    gateId: "gate-1",
    decision: "approved",
    expectedRevision: 3,
  },
];

export const continuation = {
  kind: "continue-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",4,"run-1","gate","continue-run",null,"gate-1"]',
};

export const dispatch = {
  kind: "record-dispatch",
  commandId: "c-5",
  runId: "run-1",
  operationId: continuation.operationId,
  receipt: "wrun-1",
};
