import {
  ticketStatus,
  type CycleOutcome,
  type ProtectedResult,
  type TicketStatus,
} from "cloving/workflows";
import { developTurn } from "./turn.ts";

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
): Promise<DevelopReport> {
  const { input, round, feedback } = state;
  return reportOf(
    await developTurn({
      cycleId: input.cycleId,
      repository: input.repository,
      ticket: input.ticket,
      round,
      feedback,
    }),
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

export interface DevelopFeedback {
  readonly reason: string;
  readonly output: string;
  readonly remaining: readonly string[];
}

export function repair(input: {
  readonly cycleId: string;
  readonly round: number;
  readonly report: DevelopReport;
  readonly result: { readonly reason: string | null; readonly output: string };
}): DevelopFeedback | CycleOutcome {
  const { cycleId, round, report, result } = input;
  const reason = result.reason ?? "merge-failed";
  const needsAnswer = reason === "review-changes" || reason === "not-approved";
  if (
    round === 4 ||
    reason === "ci-pending" ||
    reason === "check-not-configured" ||
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
