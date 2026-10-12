import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isHolding,
  type EffectState,
  type Evidence,
  type Lease,
  type Operation,
  type OperationStatus,
  type RunBudget,
} from "../authority/operations.ts";
import type {
  BudgetRow,
  EffectRows,
  LeaseRow,
  OperationRow,
} from "../storage/effect-rows.ts";

export interface EffectInput {
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
}

export function effectInputDigest(effect: EffectInput): string {
  const text = JSON.stringify([
    "cloving-effect-input",
    1,
    effect.capability,
    effect.method,
    effect.target,
    effect.payload,
  ]);
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function budgetRecord(budget: RunBudget): BudgetRow {
  return {
    runId: budget.runId,
    effectLimit: budget.limit,
    spent: budget.spent,
    capabilities: JSON.stringify(budget.capabilities),
    exhaustedSequence: budget.exhaustedSequence,
  };
}

function byText<Row>(
  key: (row: Row) => string,
): (left: Row, right: Row) => number {
  return (left, right) => (key(left) < key(right) ? -1 : 1);
}

export function effectRows(
  effects: EffectState,
  evidence: readonly Evidence[],
): EffectRows {
  return {
    budgets: Object.values(effects.budgets)
      .map(budgetRecord)
      .sort(byText((row) => row.runId)),
    operations: Object.values(effects.operations).sort(
      (left, right) => left.requestedSequence - right.requestedSequence,
    ),
    leases: Object.values(effects.leases).sort(
      byText((row) => row.resourceKey),
    ),
    evidence,
    stops: Object.entries(effects.stops)
      .map(([operationId, stop]) => ({ operationId, ...stop }))
      .sort(byText((row) => row.operationId)),
  };
}

const statuses: readonly OperationStatus[] = [
  "refused",
  "waiting",
  "dispatch-pending",
  "running",
  "recovering",
  "blocked",
  "completed",
  "failed",
  "stopped",
  "cancelled",
];

const leaseStates: readonly Lease["state"][] = ["held", "expired", "released"];

function storedOperation(row: OperationRow): Operation {
  const status = statuses.find((candidate) => candidate === row.status);
  if (status === undefined) throw new Error("invalid-operation-row");
  return { ...row, status };
}

function storedLease(row: LeaseRow): Lease {
  const state = leaseStates.find((candidate) => candidate === row.state);
  if (state === undefined) throw new Error("invalid-lease-row");
  return { ...row, state };
}

export function storedBudget(row: BudgetRow): RunBudget {
  const capabilities: unknown = JSON.parse(row.capabilities);
  if (!Array.isArray(capabilities)) throw new Error("invalid-budget-row");
  return {
    runId: row.runId,
    limit: row.effectLimit,
    spent: row.spent,
    capabilities: capabilities.map(String),
    exhaustedSequence: row.exhaustedSequence,
  };
}

export type StoredEffects = Pick<
  EffectRows,
  "budgets" | "operations" | "leases" | "stops"
> & { readonly holding: number };

export function storedEffects(rows: StoredEffects): EffectState {
  return {
    budgets: Object.fromEntries(
      rows.budgets.map((row) => [row.runId, storedBudget(row)]),
    ),
    operations: Object.fromEntries(
      rows.operations.map((row) => [row.operationId, storedOperation(row)]),
    ),
    leases: Object.fromEntries(
      rows.leases.map((row) => [row.resourceKey, storedLease(row)]),
    ),
    holding: rows.holding,
    stops: Object.fromEntries(
      rows.stops.map((row) => [
        row.operationId,
        { runId: row.runId, sequence: row.sequence },
      ]),
    ),
  };
}

export function effectDigests(effects: EffectState): readonly string[] {
  return Object.values(effects.operations)
    .flatMap((operation) => [operation.payload, operation.result])
    .filter((digest) => digest !== null);
}

export function effectChecks(
  rows: EffectRows,
  replay: {
    readonly effects: EffectState;
    readonly evidence: readonly Evidence[];
  },
): readonly (readonly [string, boolean])[] {
  const expected = effectRows(replay.effects, replay.evidence);
  return [
    ["budgets", isDeepStrictEqual(rows.budgets, expected.budgets)],
    ["operations", isDeepStrictEqual(rows.operations, expected.operations)],
    ["leases", isDeepStrictEqual(rows.leases, expected.leases)],
    ["effect-evidence", isDeepStrictEqual(rows.evidence, expected.evidence)],
    ["stopped-operations", isDeepStrictEqual(rows.stops, expected.stops)],
    [
      "holding",
      rows.operations.filter(isHolding).length === replay.effects.holding,
    ],
    [
      "input-digests",
      rows.operations.every(
        (row) => effectInputDigest(row) === row.inputDigest,
      ),
    ],
  ];
}
