import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";

export const auditTemplate = fileURLToPath(
  new URL("../templates/dependency-audit", import.meta.url),
);
export const ticketTemplate = fileURLToPath(
  new URL("../templates/dependency-ticket", import.meta.url),
);
export const packedAuditSources = [
  "templates/dependency-audit/dependency-audit.test.ts",
  "templates/dependency-audit/dependency-audit.ts",
  "templates/dependency-audit/dependency-audit/audit-candidates.mts",
  "templates/dependency-audit/dependency-audit/audit-ranges.mts",
  "templates/dependency-audit/dependency-audit/audit-report.mts",
  "templates/dependency-audit/dependency-audit/audit-run.mts",
  "templates/dependency-audit/dependency-audit/candidates.ts",
  "templates/dependency-audit/dependency-audit/fields.ts",
  "templates/dependency-audit/dependency-audit/plan.ts",
  "templates/dependency-audit/dependency-audit/refusal-tests.ts",
  "templates/dependency-audit/dependency-audit/scenarios.ts",
  "templates/dependency-audit/dependency-audit/ticket.ts",
  "templates/dependency-audit/dependency-audit/tickets.ts",
];
export const packedTicketSources = [
  "templates/dependency-ticket/dependency-ticket.test.ts",
  "templates/dependency-ticket/dependency-ticket.ts",
  "templates/dependency-ticket/dependency-ticket/issue.ts",
  "templates/dependency-ticket/dependency-ticket/scenarios.ts",
];

export async function auditFiles(): Promise<Record<string, string>> {
  return Object.assign(
    await developFiles(auditTemplate),
    await developFiles(ticketTemplate),
  );
}
