import type { ProtectedResult } from "../src/step-bridge.ts";
import { field, request } from "./develop-workflow-fixture.ts";

export const cycleId = "clv-063-1a2b3c4d";
export const ticket = [
  "# CLV-063: Merge the work through a pull request",
  "",
  "GitHub issue: cloving-ai/cloving-ai#63 (open)",
  "",
  "The body of the issue.",
].join("\n");
export const input = {
  cycleId,
  ticketId: "CLV-063",
  ticket,
  repository: "/repositories/cloving",
  delivery: "pull-request",
};
export const url = "https://github.com/cloving-ai/cloving-ai/pull/7";
export const first = "1".repeat(40);
export const second = "2".repeat(40);
export const about =
  "Greptile reviews the pull request, and Cloving merges it when the confidence score is 5/5.";

export function completed(result: unknown): ProtectedResult {
  return {
    kind: "completed",
    operationId: "operation",
    receipt: "receipt",
    result: JSON.stringify(result),
  };
}

export const prepared = completed({
  branch: `cloving/${cycleId}`,
  base: "main",
});
export const turned = completed({ summary: "I made the change." });
export const merged = completed({ number: 7, merged: "f".repeat(40) });

export function pull(commit: string): ProtectedResult {
  return completed({ number: 7, url, commit });
}

export function review(commit: string, score: number): ProtectedResult {
  const findings =
    score < 5 ? [{ path: "src/a.ts", line: 4, body: "Check the bound." }] : [];
  return completed({
    number: 7,
    commit,
    score,
    summary: `Confidence Score: ${String(score)}/5`,
    findings,
  });
}

export function steps(line: unknown): readonly unknown[] {
  const requests = field(line, "requests");
  return Array.isArray(requests)
    ? requests.map((item: unknown) => {
        const effect = field(item, 1);
        const scope = field(effect, "scope");
        return [
          field(effect, "capability"),
          field(effect, "method"),
          field(scope, "phase"),
          field(scope, "operation"),
          field(scope, "round"),
          field(effect, "target"),
        ];
      })
    : [];
}

export function payloadOf(line: unknown, index: number): string {
  return String(field(request(line, index), "payload"));
}
