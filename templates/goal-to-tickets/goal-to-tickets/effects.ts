import type { CycleOutcome, ProtectedResult } from "cloving/workflows";

export interface GoalInput {
  readonly cycleId: string;
  readonly input: { readonly goal: string };
}

export interface Ticket {
  readonly draft: number;
  readonly number: number;
  readonly title: string;
  readonly ready: boolean;
}

export const planFile = "cloving-goal-plan.md";

export function blocked(input: GoalInput, reason: string): CycleOutcome {
  return {
    kind: "blocked",
    cycleId: input.cycleId,
    evidenceId: "goal-to-tickets",
    reason: reason,
  };
}

export function failureReason(error: unknown): string {
  const fallback = "goal-to-tickets-failed";
  if (typeof error !== "object" || error === null) return fallback;
  const cause = "cause" in error ? error.cause : error;
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("message" in cause) ||
    typeof cause.message !== "string"
  )
    return fallback;
  return /^[a-z][a-z0-9-]{0,127}$/.test(cause.message)
    ? cause.message
    : fallback;
}

export function effectResult(result: ProtectedResult): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  return result.result ?? "null";
}

export function resultFields(text: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid-github-result");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid-github-result");
  return Object.fromEntries(Object.entries(value));
}

export function ticketsOutcome(
  input: GoalInput,
  request: { readonly tickets: readonly Ticket[]; readonly next: string },
): CycleOutcome {
  const { tickets, next } = request;
  return {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: ["issues"]
      .concat(tickets.map((ticket) => String(ticket.number)))
      .join("-"),
    report: [`Posted ${String(tickets.length)} tickets:`]
      .concat(
        tickets.map((ticket) => `#${String(ticket.number)} ${ticket.title}`),
        [next],
      )
      .join("\n"),
  };
}
