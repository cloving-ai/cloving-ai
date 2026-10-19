export interface WorkflowPromptAsset {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly instructions: string;
  readonly stage: { readonly name: string; readonly description: string };
  readonly parameters: readonly {
    readonly name: string;
    readonly description: string;
  }[];
}

export interface WorkflowSourceProjection {
  readonly maximumIterations: number;
  readonly fields: readonly string[];
  readonly assets: readonly WorkflowPromptAsset[];
  readonly gate: {
    readonly name: string;
    readonly kind: "question" | "approval";
    readonly prompt: string;
  } | null;
}

function sourceTypes(projection: WorkflowSourceProjection): string {
  return `import type { CycleOutcome, ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
type ClvInput = { cycleId: string; repository: string; input: { ${projection.fields.map((field) => `${field}: string`).join("; ")} } };
type ClvContinuation = { gateId: string; decision: "answered" | "approved" | "denied"; answer: string | null };
`;
}

function sourceChecks(): string {
  return `function clvRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
function clvStatus(result: ProtectedResult): "complete" | "repair" | "blocked" {
  if (result.kind !== "completed" || typeof result.result !== "string") return "blocked";
  try {
    const envelope = clvRecord(JSON.parse(result.result));
    const summary = envelope?.["summary"];
    if (typeof summary !== "string") return "blocked";
    const status = clvRecord(JSON.parse(summary))?.["status"];
    return status === "complete" || status === "repair" ? status : "blocked";
  } catch { return "blocked"; }
}
function clvBlocked(cycleId: string, reason: string): CycleOutcome {
  return { kind: "blocked", cycleId, reason, evidenceId: "clv-generation-1" };
}
function clvPayload(asset: unknown, input: ClvInput, round: number): string {
  return JSON.stringify({ asset, parameters: { cycleId: input.cycleId, repository: input.repository, input: input.input }, round });
}
`;
}

function sourceValidation(projection: WorkflowSourceProjection): string {
  const gate = projection.gate;
  const continuation =
    gate === null
      ? "false"
      : `value.gateId === ${JSON.stringify(gate.name)} && ${gate.kind === "question" ? 'value.decision === "answered" && typeof value.answer === "string" && value.answer.trim().length > 0 && value.answer.length <= 8000' : '(value.decision === "approved" || value.decision === "denied") && value.answer === null'}`;
  return `function clvValidInput(value: ClvInput): boolean {
  const envelope = clvRecord(value);
  const fields = clvRecord(envelope?.["input"]);
  return envelope !== null && JSON.stringify(Object.keys(envelope).sort()) === '["cycleId","input","repository"]' &&
    typeof value.cycleId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.cycleId) &&
    typeof value.repository === "string" && value.repository.trim().length > 0 && fields !== null &&
    JSON.stringify(Object.keys(fields).sort()) === ${JSON.stringify(JSON.stringify([...projection.fields].sort()))} &&
    Object.values(fields).every((field) => typeof field === "string" && field.trim().length > 0);
}
function clvValidContinuation(value: ClvContinuation): boolean {
  const fields = clvRecord(value);
  return fields !== null && JSON.stringify(Object.keys(fields).sort()) === '["answer","decision","gateId"]' && ${continuation};
}
`;
}

function sourceLoop(projection: WorkflowSourceProjection): string {
  const [review, repair] = projection.assets;
  return `  let clvPassed = false;
  let clvFailure: string | null = null;
  for (let clvRound = 0; clvRound < ${String(projection.maximumIterations)}; clvRound++) {
    if (!clvPassed && clvFailure === null) {
      const clvReview = await protectedEffect({
        scope: { phase: "clv-generated-1", operation: ${JSON.stringify(review?.stage.name)}, round: clvRound },
        capability: "claude", method: "run-turn", units: 1,
        target: input.cycleId, payload: clvPayload(clvAsset1, input, clvRound)
      });
      const clvReviewStatus = clvStatus(clvReview);
      if (clvReviewStatus === "complete") clvPassed = true;
      if (clvReviewStatus === "blocked") clvFailure = "worker-blocked";
      if (clvReviewStatus === "repair") {
        const clvRepair = await protectedEffect({
          scope: { phase: "clv-generated-1", operation: ${JSON.stringify(repair?.stage.name)}, round: clvRound },
          capability: "claude", method: "run-turn", units: 1,
          target: input.cycleId, payload: clvPayload(clvAsset2, input, clvRound)
        });
        if (clvStatus(clvRepair) === "blocked") clvFailure = "worker-blocked";
      }
    }
  }
  if (clvFailure !== null) return clvBlocked(input.cycleId, clvFailure);
  if (!clvPassed) return clvBlocked(input.cycleId, "repair-limit-exhausted");
`;
}

function sourceGate(projection: WorkflowSourceProjection): string {
  const gate = projection.gate;
  if (gate === null) return "";
  return `  if (continuation === undefined) {
    const clvGate = await decisionGate({ gateId: ${JSON.stringify(gate.name)}, kind: ${JSON.stringify(gate.kind)}, prompt: ${JSON.stringify(gate.prompt)} });
    if (clvGate.kind !== "opened") return clvBlocked(input.cycleId, "gate-unavailable");
    return { kind: "waiting_for_decision", cycleId: input.cycleId, decisionId: clvGate.decisionId };
  }
`;
}

export function renderWorkflowSource(
  projection: WorkflowSourceProjection,
): string {
  const assets = projection.assets
    .map(
      (asset, index) =>
        `const clvAsset${String(index + 1)} = ${JSON.stringify(asset)};`,
    )
    .join("\n");
  return `${sourceTypes(projection)}${assets}
${sourceChecks()}${sourceValidation(projection)}export async function clvFunction1(input: ClvInput, continuation?: ClvContinuation): Promise<CycleOutcome> {
  "use workflow";
  if (!clvValidInput(input)) return clvBlocked("clv-invalid-input", "invalid-run-input");
  if (continuation !== undefined && !clvValidContinuation(continuation)) return clvBlocked(input.cycleId, "invalid-continuation");
  if (continuation?.decision === "denied") return clvBlocked(input.cycleId, "approval-denied");
${sourceLoop(projection)}${sourceGate(projection)}  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "clv-handoff-1" };
}
`;
}
