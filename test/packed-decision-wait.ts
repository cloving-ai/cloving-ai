import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { call } from "./service-fixture.ts";
import { field, items, reached } from "./self-host-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

export function packedNotifyCommand(root: string): string {
  return JSON.stringify([
    process.execPath,
    "-e",
    `let message = ""; for await (const chunk of process.stdin) message += chunk; const { appendFileSync } = await import("node:fs"); appendFileSync(${JSON.stringify(join(root, "packed-notifications"))}, message);`,
  ]);
}

export async function packedDecisionFiles(root: string): Promise<void> {
  const base = join(root, ".cloving/workflows/decision-wait");
  await writeFile(
    `${base}.ts`,
    `
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
export async function packedDecision(input: { cycleId: string }) {
  "use workflow";
  const decision = await waitForDecision({ gateId: "packed-review", kind: "approval", prompt: "Approve the packed workflow?" });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: decision.decision };
}
`,
  );
  await writeFile(
    `${base}.declaration.json`,
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: "decision-wait",
      },
    }),
  );
}

interface PackedDisplay {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly address: string;
}

async function displayed(root: string, settings: PackedDisplay): Promise<void> {
  const cli = await promisify(execFile)(settings.executable, ["questions"], {
    cwd: root,
    env: settings.env,
  });
  assert.match(
    cli.stdout,
    /cloving approve .*\/packed-review --expected-revision 1 --generation 1 --subject-digest sha256:/,
  );
  const model: unknown = await (
    await fetch(settings.address + "data.json")
  ).json();
  assert.match(JSON.stringify(model), /Approve the packed workflow\?/);
  const notification = await reached(async () => {
    const text = await readFile(
      join(root, "packed-notifications"),
      "utf8",
    ).catch(() => "");
    return text.includes("packed-review") ? text : undefined;
  });
  assert.match(notification, /cloving approve .*packed-review/);
}

export async function runPackedDecision(
  root: string,
  settings: PackedDisplay,
): Promise<void> {
  const runtimeDirectory = join(root, "host/run");
  const asked = (
    operation: string,
    parameters: Readonly<Record<string, unknown>>,
  ) => call({ runtimeDirectory }, { operation, parameters });
  const started = await asked("run", {
    workflowId: "decision-wait",
    source: "declared",
    submission: {},
    commandId: "packed-decision-run",
  });
  assert.equal(started["kind"], "run-admitted", JSON.stringify(started));
  const runId = started["runId"];
  const pending = await reached(async () => {
    const response = await asked("questions", { runId });
    return items(response["decisions"])[0];
  });
  assert.deepEqual(field(pending, "allowed"), ["approve", "deny"]);
  const status = (await asked("status", { runId }))["run"];
  assert.equal(field(status, "condition"), "waiting-decision");
  await displayed(root, settings);
  const reply = await asked("decision", {
    command: "approve",
    reference: field(pending, "decisionId"),
    subjectDigest: field(pending, "subjectDigest"),
    expectedRevision: field(pending, "revision"),
    generation: field(pending, "generation"),
    commandId: "packed-approve",
  });
  assert.equal(reply["kind"], "decision-recorded");
  const completed = await reached(async () => {
    const status = (await asked("status", { runId }))["run"];
    return field(status, "state") === "completed" ? status : undefined;
  });
  assert.deepEqual(field(completed, "outcome"), {
    kind: "handoff_requested",
    reason: null,
    promotionId: "approved",
  });
}
