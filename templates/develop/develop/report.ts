import {
  ticketStatus,
  type CycleOutcome,
  type ProtectedResult,
  type TicketStatus,
} from "cloving/workflows";

export interface DevelopInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly input: {
    readonly ticket: { readonly id: string; readonly text: string };
  };
}

export function ticketInput(input: DevelopInput): DevelopTask {
  return {
    cycleId: input.cycleId,
    repository: input.repository,
    ticket: input.input.ticket.text,
  };
}

export interface DevelopTask {
  readonly cycleId: string;
  readonly repository: string;
  readonly ticket: string;
}

export interface DevelopReport {
  readonly summary: string;
  readonly status: TicketStatus;
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
  return {
    summary: value.summary,
    status: ticketStatus(
      value.summary,
      "ticketStatus" in value ? value.ticketStatus : undefined,
    ),
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
