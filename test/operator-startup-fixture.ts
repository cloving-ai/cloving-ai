import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call } from "./service-fixture.ts";
import { field, reached } from "./self-host-fixture.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

interface OperatorFixture {
  readonly root: string;
  readonly repository: string;
  readonly runtimeDirectory: string;
}

export const operatorRefusals = [
  { scope: "user", label: "export.ts", codes: ["unsupported-source"] },
  { scope: "user", label: "initialize.ts", codes: ["unsupported-source"] },
  { scope: "user", label: "refused.ts", codes: ["invalid-declaration"] },
  { scope: "user", label: "throw.ts", codes: ["unsupported-source"] },
];

function refusedFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const refused = join(root, "config/cloving/workflows/refused");
  files[`${refused}.ts`] =
    'export async function refused() { "use workflow"; return "SOURCE_SENTINEL"; }';
  files[`${refused}.declaration.json`] = JSON.stringify({
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, workflowId: "" },
  });
  for (const [name, statement] of Object.entries({
    export: "export const developTicket = 1;",
    initialize: 'const parsed = JSON.parse("SOURCE_SENTINEL");',
    throw: 'throw new Error("SOURCE_SENTINEL");',
  })) {
    const base = join(root, "config/cloving/workflows", name);
    files[`${base}.ts`] =
      `${statement}\n${validCandidateSource.replaceAll("candidate", `${name}Workflow`)}`;
    files[`${base}.declaration.json`] = JSON.stringify({
      ...candidateDeclaration,
      workflow: { ...candidateDeclaration.workflow, workflowId: name },
    });
  }
  return files;
}

export async function operatorFiles(fixture: OperatorFixture) {
  const files: Record<string, string> = {};
  for (const scope of ["project", "user"] as const) {
    const folder =
      scope === "project"
        ? join(fixture.repository, ".cloving/workflows")
        : join(fixture.root, "config/cloving/workflows");
    await mkdir(folder, { recursive: true });
    const baseName = `${scope}'s-workflow`;
    files[join(folder, `${baseName}.ts`)] = `
import { loadCycle } from "cloving/workflows/steps/load-cycle";
export async function ${scope}Workflow(input: { cycleId: string; repository: string; input: { repository: string } }) {
  "use workflow";
  const loaded = await loadCycle({ cycleId: input.cycleId });
  return { kind: loaded.kind === "unavailable" && input.repository === ${JSON.stringify(fixture.repository)} && input.input.repository === "submitted-override" ? "handoff_requested" : "blocked" };
}`;
    files[join(folder, `${baseName}.declaration.json`)] = JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: `${scope}-run`,
        capabilities: ["claude", "claude"],
        input: {
          maximumBytes: 1024,
          fields: { repository: { type: "string" } },
        },
      },
    });
  }
  Object.assign(files, refusedFiles(fixture.root));
  for (const [name, bytes] of Object.entries(files))
    await writeFile(name, bytes);
  return files;
}

export async function runOperator(
  fixture: OperatorFixture,
  workflowId: string,
) {
  const admitted = await call(fixture, {
    operation: "run",
    parameters: {
      workflowId,
      source: "declared",
      commandId: workflowId,
      submission: { repository: "submitted-override" },
    },
  });
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
  const run = await reached(async () => {
    const shown = await call(fixture, {
      operation: "status",
      parameters: { runId: admitted["runId"] },
    });
    const state = field(shown["run"], "state");
    return ["completed", "blocked", "failed"].includes(String(state))
      ? shown["run"]
      : undefined;
  });
  assert.deepEqual(field(run, "outcome"), {
    kind: "handoff_requested",
    reason: null,
  });
  assert.deepEqual(field(run, "budget"), { limit: 1, spent: 0 });
}
