import {
  ticketStatus,
  type CycleOutcome,
  type ProtectedResult,
  type TicketStatus,
} from "cloving/workflows";
import { developTurn, type DevelopTurnInput } from "./turn.ts";

export interface DevelopInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly input:
    | {
        readonly ticket: { readonly id: string; readonly text: string };
      }
    | { readonly prompt: string };
}

export function ticketInput(input: DevelopInput): DevelopTask {
  if (!("ticket" in input.input)) throw new Error("ticket-input-required");
  return {
    cycleId: input.cycleId,
    repository: input.repository,
    ticket: input.input.ticket.text,
    issue: ticketIssue(input.input.ticket.text),
  };
}

export function promptInput(input: DevelopInput): DevelopTask {
  if (!("prompt" in input.input)) throw new Error("prompt-input-required");
  return {
    cycleId: input.cycleId,
    repository: input.repository,
    ticket: input.input.prompt,
    issue: null,
  };
}

export interface DevelopTask {
  readonly cycleId: string;
  readonly repository: string;
  readonly ticket: string;
  readonly issue: {
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
  } | null;
}

function ticketIssue(ticket: string) {
  const match = /^GitHub issue: ([\w.-]+)\/([\w.-]+)#(\d+)/m.exec(ticket);
  if (match === null) return null;
  return {
    owner: match[1] ?? "",
    repository: match[2] ?? "",
    number: Number(match[3]),
  };
}

export interface DevelopReport {
  readonly summary: string;
  readonly status: TicketStatus;
  readonly commit: string | null;
  readonly clean: boolean;
}

export interface DevelopState {
  readonly input: DevelopTask;
  readonly round: number;
  readonly feedback: DevelopFeedback | null;
}

export async function developReport(
  state: DevelopState,
): Promise<DevelopReport | CycleOutcome> {
  const first = await developTurn(turnRequest(state, "initial"));
  if (!interrupted(first)) return reportOf(first);
  const second = await developTurn(turnRequest(state, "continuation"));
  if (!interrupted(second)) return reportOf(second);
  return {
    kind: "blocked",
    cycleId: state.input.cycleId,
    reason: "turn-interrupted",
    evidenceId: "implement",
  };
}

function turnRequest(
  state: DevelopState,
  attempt: "initial" | "continuation",
): DevelopTurnInput {
  return {
    cycleId: state.input.cycleId,
    repository: state.input.repository,
    ticket: state.input.ticket,
    round: state.round,
    attempt,
    feedback: state.feedback,
  };
}

function interrupted(result: ProtectedResult): boolean {
  return (
    result.kind !== "completed" && result.reason === "claude-turn-interrupted"
  );
}

export function reportOf(result: ProtectedResult): DevelopReport {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  const value: unknown = JSON.parse(result.result ?? "null");
  if (
    typeof value !== "object" ||
    value === null ||
    !("summary" in value) ||
    typeof value.summary !== "string"
  )
    throw new Error("invalid-development-report");
  const snapshot = commitSnapshot(value);
  return {
    summary: value.summary,
    commit: snapshot.commit,
    clean: snapshot.clean,
    status: ticketStatus(
      value.summary,
      "ticketStatus" in value ? value.ticketStatus : undefined,
    ),
  };
}

function commitSnapshot(value: object) {
  return {
    commit:
      "commit" in value && typeof value.commit === "string"
        ? value.commit
        : null,
    clean:
      "uncommitted" in value &&
      Array.isArray(value.uncommitted) &&
      value.uncommitted.length === 0,
  };
}

export interface RoundResult {
  readonly merged: boolean;
  readonly reason: string | null;
  readonly output: string;
  readonly findings?: number;
}

export interface DevelopFailure {
  readonly error: unknown;
}

export function endOf(state: {
  readonly outcome: CycleOutcome | null;
  readonly failure: DevelopFailure | null;
}): CycleOutcome {
  if (state.failure !== null) throw state.failure.error;
  if (state.outcome === null) throw new Error("development-round-limit");
  return state.outcome;
}

export interface DevelopFeedback {
  readonly reason: string;
  readonly output: string;
  readonly remaining: readonly string[];
  readonly limit?: number;
  readonly conflicts?: number;
}

export const waitReasons = [
  "ci-pending",
  "check-not-configured",
  "merge-queue-removed",
  "merge-queue-timeout",
];

export function repair(input: {
  readonly cycleId: string;
  readonly round: number;
  readonly report: DevelopReport;
  readonly result: { readonly reason: string | null; readonly output: string };
  readonly limit?: number;
}): DevelopFeedback | CycleOutcome {
  const { cycleId, round, report, result } = input;
  const reason = result.reason ?? "merge-failed";
  const needsAnswer = reason === "review-changes" || reason === "not-approved";
  if (
    round >= (input.limit ?? 4) ||
    waitReasons.includes(reason) ||
    (needsAnswer && result.output.trim() === "")
  )
    return {
      kind: "blocked",
      cycleId,
      reason,
      evidenceId: reason === "review-changes" ? "review" : "merge",
    };
  return {
    reason,
    output: result.output,
    remaining: report.status.kind === "partial" ? report.status.remaining : [],
  };
}
