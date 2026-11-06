import type { ProtectedResult } from "cloving/workflows";
import type { ScenarioRequest } from "cloving/workflows/testing";
import { completed, effects } from "./scenarios.ts";

export function editable(): Record<
  keyof ReturnType<typeof effects>,
  ProtectedResult[]
> {
  return effects();
}

export function failure(reason: string) {
  return { kind: "failed" as const, operationId: "failed", reason };
}

export function calls(requests: readonly ScenarioRequest[]): string[] {
  return requests.map((request) => {
    if (request[0] === "effect") return request[1].method;
    if (request[0] === "sleep")
      return "seconds" in request[1]
        ? `sleep ${String(request[1].seconds)}`
        : "sleep";
    return request[0];
  });
}

export function failingRounds(merges: readonly ReturnType<typeof completed>[]) {
  const scenario = effects();
  const rounds = merges.length;
  return {
    ...scenario,
    "claude run-turn": Array.from(
      { length: rounds },
      () => scenario["claude run-turn"][0] ?? completed(null),
    ),
    "github open-pr": Array.from(
      { length: rounds },
      () => scenario["github open-pr"][0] ?? completed(null),
    ),
    "github wait-review": Array.from(
      { length: rounds },
      () => scenario["github wait-review"][0] ?? completed(null),
    ),
    "github merge": merges,
  };
}

export const checkFailed = completed({
  reason: "check-failed",
  output: "Check output.\n",
});

export function answered(answer: string) {
  return { decision: "answered" as const, answer };
}

export function questions(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request) =>
    request[0] === "waitForDecision" ? [request[1]] : [],
  );
}

export const conflictOutput = [
  "Auto-merging src/counter.ts",
  "CONFLICT (content): Merge conflict in src/counter.ts",
  "CONFLICT (modify/delete): src/old.ts deleted in origin/main and modified in HEAD.",
  "Automatic merge failed; fix conflicts and then commit the result.",
  "src/counter.ts",
  "src/old.ts",
].join("\n");

export const conflict = completed({
  reason: "merge-conflict",
  output: conflictOutput,
});

export function retried<Value>(value: Value) {
  return [
    failure("git-call-failed"),
    failure("git-network-failed"),
    failure("github-network-failed"),
    value,
  ];
}
