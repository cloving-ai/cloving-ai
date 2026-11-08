import type { CycleOutcome } from "cloving/workflows";
import { auditDocs, type Drift } from "./docs-drift/audit.ts";
import {
  docsCandidates,
  recordAudit,
  type DriftInput,
  type Scan,
} from "./docs-drift/commands.ts";
import { postTicket } from "./docs-drift/issue.ts";
import { fileTickets } from "./docs-drift/tickets.ts";

function driftReport(
  scan: Scan,
  drifts: {
    readonly filed: readonly Drift[];
    readonly left: readonly string[];
  },
): string {
  const audited = `Docs audited: ${String(scan.candidates.length)} at ${scan.commit.slice(0, 12)}.`;
  const more =
    scan.more === 0 ? "" : ` Docs over the limit of 15: ${String(scan.more)}.`;
  if (drifts.filed.length === 0) return `${audited} No drift.${more}`;
  const filed = drifts.filed.map((drift) => drift.doc).join(", ");
  return `${audited} Ticket runs requested: ${String(drifts.filed.length)} (${filed}). Left for a later audit: ${drifts.left.join(", ") || "none"}.${more}`;
}

export async function docsDrift(input: DriftInput): Promise<CycleOutcome> {
  "use workflow";
  try {
    const ticket = input.input.text;
    if (ticket !== undefined)
      return await postTicket({ cycleId: input.cycleId, text: ticket });
    const scan = await docsCandidates();
    if (scan.candidates.length === 0)
      return {
        kind: "handoff_requested",
        cycleId: input.cycleId,
        promotionId: "docs-drift",
        report: "No doc names code that changed after its last audit.",
      };
    const drifts = await auditDocs({ input: input, scan: scan });
    const filed = await fileTickets({ drifts: drifts, commit: scan.commit });
    const drifted = drifts.map((drift) => drift.doc);
    await recordAudit({
      commit: scan.commit,
      docs: scan.candidates
        .map((item) => item.doc)
        .filter((doc) => !drifted.includes(doc)),
    });
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "docs-drift",
      report: driftReport(scan, {
        filed: filed,
        left: drifted.slice(filed.length),
      }),
    };
  } catch (error) {
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      evidenceId: "docs-drift",
      reason:
        error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/.test(error.message)
          ? error.message
          : "docs-drift-failed",
    };
  }
}
