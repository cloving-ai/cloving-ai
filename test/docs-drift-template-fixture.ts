import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";

export const driftTemplate = fileURLToPath(
  new URL("../templates/docs-drift", import.meta.url),
);
export const packedDriftSources = [
  "templates/docs-drift/docs-drift.test.ts",
  "templates/docs-drift/docs-drift.ts",
  "templates/docs-drift/docs-drift/audit.ts",
  "templates/docs-drift/docs-drift/commands.ts",
  "templates/docs-drift/docs-drift/doc-mentions.mts",
  "templates/docs-drift/docs-drift/docs-candidates.mts",
  "templates/docs-drift/docs-drift/docs-drift-record.mts",
  "templates/docs-drift/docs-drift/docs-record.mts",
  "templates/docs-drift/docs-drift/docs-scan.mts",
  "templates/docs-drift/docs-drift/fields.ts",
  "templates/docs-drift/docs-drift/issue.ts",
  "templates/docs-drift/docs-drift/refusal-tests.ts",
  "templates/docs-drift/docs-drift/scenarios.ts",
  "templates/docs-drift/docs-drift/ticket.ts",
  "templates/docs-drift/docs-drift/tickets.ts",
];

export async function driftFiles(): Promise<Record<string, string>> {
  return await developFiles(driftTemplate);
}
