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
  step: {
    readonly operation: string;
    readonly payload: unknown;
    readonly round?: number;
  },
): ProtectedRequest {
  const { operation, payload } = step;
  return {
    scope: { phase: "analysis", operation, round: step.round ?? 1 },
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
): string | null {
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
  return null;
}

async function askDraft(
  cycleId: string,
  continuation: {
    readonly draft: Readonly<Record<string, unknown>>;
    readonly decision: Decision | undefined;
  },
): Promise<
  CycleOutcome | { readonly kind: "answered"; readonly answer: string }
> {
  const { draft, decision } = continuation;
  if (!usableDraft(cycleId, draft))
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-input-refused",
      evidenceId: "save-analysis",
    };
  if (decision !== undefined) {
    const reason = draftAnswer(draft, decision);
    if (reason === null)
      return { kind: "answered", answer: decision.answer ?? "" };
    return {
      kind: "blocked",
      cycleId,
      reason,
      evidenceId: "analysis-question",
    };
  }
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
      readonly data: TurnInput;
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
  const captured = fields(read.result);
  const snapshot = captured["snapshot"];
  if (!record(snapshot) || snapshot["importId"] !== importId)
    return {
      kind: "blocked",
      cycleId,
      reason: "analysis-input-refused",
      evidenceId: "read-analysis",
    };
  return runTurn(input, batchData(captured, snapshot));
}

interface TurnInput {
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly batch?: Readonly<Record<string, unknown>>;
  readonly followUp?: { readonly draft: unknown; readonly answer: string };
}

function batchData(
  value: Readonly<Record<string, unknown>>,
  snapshot: Readonly<Record<string, unknown>>,
): TurnInput {
  const context = value["context"];
  const batch = value["batch"];
  return {
    snapshot,
    ...(record(context) ? { context } : {}),
    ...(record(batch) ? { batch } : {}),
  };
}

async function runTurn(input: AnalysisInput, data: TurnInput) {
  const { cycleId } = input;
  const { snapshot, followUp, context } = data;
  const turn = await protectedEffect(
    request(input.input.importId, {
      operation: "turn-analysis",
      payload: {
        snapshot,
        ...(context === undefined ? {} : { context }),
        ...(followUp === undefined ? {} : { followUp }),
      },
      round: turnRound(data),
    }),
  );
  if (turn.kind !== "completed")
    return blocked(cycleId, { operation: "turn-analysis", result: turn });
  const reply = fields(turn.result)["reply"];
  if (typeof reply !== "string")
    return {
      kind: "blocked" as const,
      cycleId,
      reason: "analysis-turn-failed",
      evidenceId: "turn-analysis",
    };
  return { kind: "analyzed" as const, data, reply };
}

function handoff(cycleId: string, importId: string): CycleOutcome {
  return {
    kind: "handoff_requested",
    cycleId,
    promotionId: `analysis:${importId}:${cycleId}`,
  };
}

function turnRound(data: TurnInput): number {
  if (data.followUp !== undefined) return data.batch === undefined ? 2 : 5;
  return Number(data.batch?.["batchIndex"] ?? 0) + 1;
}

async function saveTurn(
  input: AnalysisInput,
  turn: { readonly data: TurnInput; readonly reply: string },
): Promise<ProtectedResult> {
  const { batch, followUp } = turn.data;
  return protectedEffect(
    request(input.input.importId, {
      operation: "save-analysis",
      round: turnRound(turn.data),
      payload: {
        importId: input.input.importId,
        cycleId: input.cycleId,
        reply: turn.reply,
        ...(batch === undefined ? {} : { batch }),
        ...(followUp === undefined ? {} : { followUp }),
      },
    }),
  );
}

export async function analyzeChats(
  input: AnalysisInput,
  decision?: Decision,
): Promise<CycleOutcome> {
  "use workflow";
  const { cycleId } = input;
  const { importId } = input.input;
  let analyzed = await firstTurn(input);
  let answered = false;
  while (analyzed.kind === "analyzed") {
    const { data, reply } = analyzed;
    const save = await saveTurn(input, analyzed);
    if (save.kind !== "completed")
      return blocked(cycleId, { operation: "save-analysis", result: save });
    const saved = fields(save.result);
    if (saved["kind"] === "analysis_draft") {
      analyzed = await questionTurn(input, {
        saved,
        data,
        reply,
        decision,
        answered,
      });
      answered = true;
      continue;
    }
    if (saved["kind"] !== "analysis_batch")
      return finishBatch(input, {
        saved,
        decision: answered ? undefined : decision,
      });
    const nextSnapshot = saved["snapshot"];
    if (!record(nextSnapshot) || nextSnapshot["importId"] !== importId)
      return blocked(cycleId, {
        operation: "save-analysis",
        result: { kind: "refused", reason: "analysis-input-refused" },
      });
    analyzed = await runTurn(input, batchData(saved, nextSnapshot));
  }
  return analyzed;
}

async function questionTurn(
  input: AnalysisInput,
  continuation: {
    readonly saved: Readonly<Record<string, unknown>>;
    readonly data: TurnInput;
    readonly reply: string;
    readonly decision: Decision | undefined;
    readonly answered: boolean;
  },
) {
  const { saved, data, reply, decision, answered } = continuation;
  if (answered)
    return blocked(input.cycleId, {
      operation: "save-analysis",
      result: { kind: "refused", reason: "analysis-question-limit" },
    });
  const answer = await askDraft(input.cycleId, { draft: saved, decision });
  if (answer.kind !== "answered") return answer;
  return runTurn(input, {
    ...data,
    followUp: { draft: fields(reply), answer: answer.answer },
  });
}

function finishBatch(
  input: AnalysisInput,
  result: {
    readonly saved: Readonly<Record<string, unknown>>;
    readonly decision: Decision | undefined;
  },
): CycleOutcome {
  const { cycleId } = input;
  const { importId } = input.input;
  const { saved, decision } = result;
  if (saved["kind"] === "analysis_partial")
    return {
      kind: "blocked",
      cycleId,
      reason: String(saved["reason"]),
      evidenceId: "save-analysis",
    };
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
  return handoff(cycleId, importId);
}
