import type { RunDetails } from "./details.ts";
import type { GateState } from "./gates.ts";
import type { RunClosure } from "./stop-sequence.ts";
import type { RunState } from "./transitions.ts";

export interface OperationSummary {
  readonly operationId: string;
  readonly kind: "start-run" | "continue-run" | "protected-effect";
  readonly releasedSequence: number | null;
  readonly outcomes: readonly (string | null)[];
}

export interface EffectSummary {
  readonly operationId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly leaseGeneration: number | null;
  readonly attempts: number;
  readonly limit: number;
}

export interface BudgetSummary {
  readonly limit: number;
  readonly spent: number;
}

export interface StatusInput {
  readonly run: RunState;
  readonly details: RunDetails | undefined;
  readonly gates: readonly GateState[];
  readonly operations: readonly OperationSummary[];
  readonly latestSequence: number;
  readonly silent: boolean;
  readonly closure: RunClosure | null;
  readonly effects: readonly EffectSummary[];
  readonly budget: BudgetSummary | null;
  readonly effectEvidence: readonly number[];
}

export interface Assessment {
  readonly condition: string;
  readonly code: string;
  readonly nextAction: string | null;
  readonly nextActionAt?: string | null;
  readonly detail?: string;
  readonly humanInputCanHelp: boolean;
}

export function last(operation: OperationSummary): string | null | undefined {
  return operation.outcomes.at(-1);
}

export function inFlight(operations: readonly OperationSummary[]): boolean {
  return operations.some((operation) => last(operation) === null);
}

export function assessed(
  condition: string,
  rest: Omit<Assessment, "condition">,
): Assessment {
  return { condition, ...rest };
}
