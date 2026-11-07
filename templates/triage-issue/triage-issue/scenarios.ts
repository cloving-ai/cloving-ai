import type { ProtectedResult } from "cloving/workflows";
import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { post: "person" };
export const pass = { cycleId: "triage-pass-1", input: {} };
export const issue = { cycleId: "triage-639", input: { issue: 639 } };

export const duplicateSummary = [
  "The error `bundle digest mismatch after reload` is the same as in #599, which is closed.",
  "Evidence: #599 and src/daemon/workflow-reload.ts:88.",
  "",
  "Triage: duplicate #599",
].join("\n");

export function completed(value: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

export function failed(reason: string) {
  return { kind: "failed" as const, operationId: "operation", reason };
}

export function candidates(issues: readonly unknown[]) {
  return { "command run:triage-candidates": [completed(issues)] };
}

export function handedOff(runIds: readonly string[]) {
  return runIds.map((runId) => ({
    kind: "completed" as const,
    operationId: "handoff",
    receipt: null,
    result: runId,
  }));
}

export function triageEffects(
  summary: string,
  posted: ProtectedResult = completed({ number: 639 }),
) {
  return {
    "github prepare": [completed({ target: issue.cycleId })],
    "claude run-turn": [completed({ summary: summary })],
    "github comment-issue": [posted],
    "github label": [completed({ number: 639 })],
    "github discard": [completed({ discarded: "cloving/triage-639" })],
  };
}

export function methods(requests: readonly ScenarioRequest[]) {
  return requests.map((request) =>
    request[0] === "effect" ? request[1].method : request[0],
  );
}

export function payloads(
  requests: readonly ScenarioRequest[],
  method: string,
): readonly unknown[] {
  return requests.flatMap((request) => {
    if (request[0] !== "effect" || request[1].method !== method) return [];
    const payload: unknown = JSON.parse(request[1].payload);
    return [payload];
  });
}

export function turnPrompt(requests: readonly ScenarioRequest[]): string {
  return requests
    .flatMap((request) =>
      request[0] === "effect" && request[1].method === "run-turn"
        ? [request[1].payload]
        : [],
    )
    .join("\n");
}

export function prompts(requests: readonly ScenarioRequest[]): string {
  return requests
    .flatMap((request) =>
      request[0] === "waitForDecision" ? [request[1].prompt] : [],
    )
    .join("\n");
}

export function approvals(decision: "approved" | "denied") {
  return selection.post === "person" ? [{ decision, answer: null }] : [];
}

export function asked(): readonly string[] {
  return selection.post === "person" ? ["waitForDecision"] : [];
}
