import type { CycleOutcome } from "cloving/workflows";
import {
  auditCandidates,
  type AuditInput,
  type Candidate,
} from "./dependency-audit/candidates.ts";
import { planTickets, type TicketPlan } from "./dependency-audit/plan.ts";
import { fileTickets } from "./dependency-audit/tickets.ts";

function auditReport(
  candidates: readonly Candidate[],
  requested: readonly TicketPlan[],
): string {
  const names = requested.flatMap((plan) =>
    plan.packages.map((item) => item.name),
  );
  const left = candidates
    .filter((item) => !names.includes(item.name))
    .map((item) => item.name);
  const advisories = candidates.reduce(
    (count, item) => count + item.advisories.length,
    0,
  );
  return `Advisories: ${String(advisories)} in ${String(candidates.length)} packages. Ticket runs requested: ${String(requested.length)} (${names.join(", ")}). Left for a later audit: ${left.join(", ") || "none"}.`;
}

export async function dependencyAudit(
  input: AuditInput,
): Promise<CycleOutcome> {
  "use workflow";
  try {
    const candidates = await auditCandidates();
    if (candidates.length === 0)
      return {
        kind: "handoff_requested",
        cycleId: input.cycleId,
        promotionId: "dependency-audit",
        report: "No new critical or high advisory.",
      };
    const plans = await planTickets({ input: input, candidates: candidates });
    const requested = await fileTickets(plans);
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "dependency-audit",
      report: auditReport(candidates, requested),
    };
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "dependency-audit",
      reason:
        error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
          ? error.message
          : "dependency-audit-failed",
    };
  }
}
