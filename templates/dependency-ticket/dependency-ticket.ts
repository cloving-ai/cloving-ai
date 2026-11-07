import type { CycleOutcome } from "cloving/workflows";
import {
  createIssue,
  labelIssue,
  type TicketInput,
} from "./dependency-ticket/issue.ts";

export async function dependencyTicket(
  input: TicketInput,
): Promise<CycleOutcome> {
  "use workflow";
  try {
    const number = await createIssue(input);
    await labelIssue({ input: input, number: number });
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: `issue-${String(number)}`,
      report: `Created the security issue #${String(number)}.`,
    };
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "dependency-ticket",
      reason:
        error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
          ? error.message
          : "dependency-ticket-failed",
    };
  }
}
