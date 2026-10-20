import type {
  CycleOutcome,
  ProtectedRequest,
  ProtectedResult,
} from "cloving/workflows";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

interface Decision {
  readonly gateId: string;
  readonly decision: string;
  readonly answer: string | null;
}

interface AnalysisInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly input: { readonly importId: string };
}

function request(
  importId: string,
  step: { readonly operation: string; readonly payload: unknown },
): ProtectedRequest {
  const { operation, payload } = step;
  return {
    scope: { phase: "analysis", operation, round: 1 },
    capability: operation === "turn-analysis" ? "claude" : "chats",
    method:
      operation === "turn-analysis" ? "run-turn:analyze-chats" : operation,
    target: importId,
    payload: JSON.stringify(payload),
    units: 1,
  };
}

function blocked(
  cycleId: string,
  failure: { readonly operation: string; readonly result: ProtectedResult },
): CycleOutcome {
  const { operation, result } = failure;
  return {
    kind: "blocked",
    cycleId,
    evidenceId: operation,
    reason:
      "reason" in result && result.reason !== null
        ? result.reason
        : result.kind,
  };
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(result: string | null): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(result ?? "null");
    return record(value) ? value : {};
  } catch {
    return {};
  }
}

interface Draft extends Readonly<Record<string, unknown>> {
  readonly candidateDigest: string;
  readonly expiresAt: string;
  readonly question: Readonly<Record<string, unknown>>;
}

function usableDraft(
  cycleId: string,
  draft: Readonly<Record<string, unknown>>,
): draft is Draft {
  return (
    draft["cycleId"] === cycleId &&
    typeof draft["candidateDigest"] === "string" &&
    /^[a-f0-9]{64}$/.test(draft["candidateDigest"]) &&
    typeof draft["expiresAt"] === "string" &&
    record(draft["question"])
  );
}

function draftAnswer(
  draft: Readonly<Record<string, unknown>>,
  decision: Decision,
): string {
  if (decision.decision === "expired") return "analysis-answer-missing";
  const question = draft["question"];
  const choices = record(question) ? question["choices"] : undefined;
  if (
    decision.gateId !== "analysis-question" ||
    decision.decision !== "answered" ||
    typeof decision.answer !== "string" ||
    !Array.isArray(choices) ||
    !choices.some(
      (choice: unknown) => record(choice) && choice["id"] === decision.answer,
    )
  )
    return "analysis-answer-invalid";
  return "analysis-input-refused";
}

async function askDraft(
  cycleId: string,
  continuation: {
    readonly draft: Readonly<Record<string, unknown>>;
    readonly decision: Decision | undefined;
  },
): Promise<CycleOutcome> {
  const { draft, decision } = continuation;
  if (!usableDraft(cycleId, draft))
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-input-refused",
      evidenceId: "save-analysis",
    };
  if (decision !== undefined)
    return {
      kind: "blocked",
      cycleId,
      reason: draftAnswer(draft, decision),
      evidenceId: "analysis-question",
    };
  const gate = await decisionGate({
    gateId: "analysis-question",
    kind: "question",
    prompt: JSON.stringify({
      candidateDigest: draft["candidateDigest"],
      question: draft["question"],
    }),
    expiresAt: draft.expiresAt,
  });
  if (gate.kind !== "opened")
    return {
      kind: "blocked",
      cycleId,
      reason: gate.reason,
      evidenceId: "analysis-question",
    };
  return { kind: "waiting_for_decision", cycleId, decisionId: gate.decisionId };
}

async function firstTurn(input: AnalysisInput): Promise<
  | CycleOutcome
  | {
      readonly kind: "analyzed";
      readonly snapshot: Readonly<Record<string, unknown>>;
      readonly reply: string;
    }
> {
  const { cycleId } = input;
  const { importId } = input.input;
  const read = await protectedEffect(
    request(importId, { operation: "read-analysis", payload: { importId } }),
  );
  if (read.kind !== "completed")
    return blocked(cycleId, { operation: "read-analysis", result: read });
  const snapshot = fields(read.result)["snapshot"];
  if (!record(snapshot) || snapshot["importId"] !== importId)
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-input-refused",
      evidenceId: "read-analysis",
    };
  const turn = await protectedEffect(
    request(importId, { operation: "turn-analysis", payload: { snapshot } }),
  );
  if (turn.kind !== "completed")
    return blocked(cycleId, { operation: "turn-analysis", result: turn });
  const reply = fields(turn.result)["reply"];
  if (typeof reply !== "string")
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-turn-failed",
      evidenceId: "turn-analysis",
    };
  return { kind: "analyzed", snapshot, reply };
}

export async function analyzeChats(
  input: AnalysisInput,
  decision?: Decision,
): Promise<CycleOutcome> {
  "use workflow";
  const { cycleId } = input;
  const { importId } = input.input;
  const analyzed = await firstTurn(input);
  if (analyzed.kind !== "analyzed") return analyzed;
  const { snapshot, reply } = analyzed;
  const save = await protectedEffect(
    request(importId, {
      operation: "save-analysis",
      payload: { importId, cycleId, snapshot, reply },
    }),
  );
  if (save.kind !== "completed")
    return blocked(cycleId, { operation: "save-analysis", result: save });
  const saved = fields(save.result);
  if (saved["kind"] === "analysis_draft")
    return askDraft(cycleId, { draft: saved, decision });
  if (decision !== undefined)
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-answer-invalid",
      evidenceId: "analysis-question",
    };
  if (saved["kind"] !== "handoff_requested")
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-input-refused",
      evidenceId: "save-analysis",
    };
  return {
    kind: "handoff_requested",
    cycleId,
    promotionId: `analysis:${importId}:${cycleId}`,
  };
}
