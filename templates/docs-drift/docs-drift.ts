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
    readonly commit: string;
    readonly filed: readonly Drift[];
    readonly left: readonly string[];
  },
): string {
  const audited = `Docs audited: ${String(scan.candidates.length)} at ${drifts.commit.slice(0, 12)}.`;
  const more =
    scan.more === 0 ? "" : ` Docs over the limit of 15: ${String(scan.more)}.`;
  const left = drifts.left.join(", ");
  if (drifts.filed.length === 0 && left === "")
    return `${audited} No drift.${more}`;
  if (drifts.filed.length === 0)
    return `${audited} No ticket. Left for a later audit: ${left}.${more}`;
  const filed = drifts.filed.map((drift) => drift.doc).join(", ");
  return `${audited} Ticket runs requested: ${String(drifts.filed.length)} (${filed}). Left for a later audit: ${left || "none"}.${more}`;
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
    const audit = await auditDocs({ input: input, scan: scan });
    const filed = await fileTickets({
      drifts: audit.drifts,
      commit: audit.commit,
    });
    const drifted = audit.drifts.map((drift) => drift.doc);
    await recordAudit({
      commit: audit.commit,
      docs: scan.candidates
        .map((item) => item.doc)
        .filter((doc) => !drifted.includes(doc) && !audit.left.includes(doc)),
    });
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "docs-drift",
      report: driftReport(scan, {
        commit: audit.commit,
        filed: filed,
        left: drifted.slice(filed.length).concat(audit.left),
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
