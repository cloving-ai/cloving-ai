import type {
  CycleOutcome,
  ProtectedRequest,
  ProtectedResult,
} from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

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

export async function analyzeChats(
  input: AnalysisInput,
): Promise<CycleOutcome> {
  "use workflow";
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
  const save = await protectedEffect(
    request(importId, {
      operation: "save-analysis",
      payload: { importId, cycleId, snapshot, reply },
    }),
  );
  if (save.kind !== "completed")
    return blocked(cycleId, { operation: "save-analysis", result: save });
  return {
    kind: "handoff_requested",
    cycleId,
    promotionId: `analysis:${importId}:${cycleId}`,
  };
}
