import {
  mergeRequest,
  type MergeReason,
  type MergeRequest,
  type MergeResult,
  type PullRequest,
} from "../merge-request.ts";
import { record, type Fields } from "../protocol.ts";
import type { ProtectedResult } from "../step-bridge.ts";
import { protectedEffect } from "./protected-effect.ts";

const repairReasons: readonly MergeReason[] = [
  "check-failed",
  "merge-conflict",
  "ci-failed",
  "ci-pending",
];

export async function mergeWhenGreen(
  request: MergeRequest,
): Promise<MergeResult> {
  const { pull, check, round } = mergeRequest(request);
  const effect = await protectedEffect({
    capability: "github",
    method: "merge",
    target: pull.target,
    payload: JSON.stringify({
      number: pull.number,
      commit: pull.commit,
      check,
    }),
    scope: {
      phase: "merge",
      operation: "merge",
      round,
      key: `${String(pull.number)}:${pull.commit}`,
    },
    units: 1,
  });
  return mergeOutcome(effect, pull);
}

function mergeOutcome(effect: ProtectedResult, pull: PullRequest): MergeResult {
  if (effect.kind !== "completed") return notMerged(effect);
  const result = parsedResult(effect.result);
  const reason = repairReasons.find((name) => name === result["reason"]);
  if (reason !== undefined && typeof result["output"] === "string")
    return { merged: false, reason, output: result["output"] };
  if (
    result["reason"] !== undefined ||
    result["number"] !== pull.number ||
    result["commit"] !== pull.commit ||
    typeof result["merged"] !== "string"
  )
    throw new Error("invalid-merge-result");
  return { merged: true, reason: null, output: "" };
}

function notMerged(
  effect: Exclude<ProtectedResult, { readonly kind: "completed" }>,
): MergeResult {
  if (effect.kind === "failed" && effect.reason === "check-not-configured")
    return { merged: false, reason: "check-not-configured", output: "" };
  throw new Error(effect.reason ?? effect.kind);
}

function parsedResult(text: string | null): Fields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "null");
  } catch {
    throw new Error("invalid-merge-result");
  }
  const result = record(parsed);
  if (result === undefined) throw new Error("invalid-merge-result");
  return result;
}
