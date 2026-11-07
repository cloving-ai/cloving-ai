import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { accept: "greptile", merge: "green" };
export const head = "a".repeat(40);
export const commit = "b".repeat(40);
export const target = "task-000000000641";
export const input = {
  cycleId: "rescue-1",
  repository: "main-checkout",
  input: {
    pullRequest: 641,
    reason: "merge-conflict",
    issue: "acme/demo#627",
    ticketStatus: "complete",
  },
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function completed(result: { readonly [key: string]: JsonValue }) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(result),
  };
}

export function prepared() {
  return completed({
    target,
    branch: `cloving/${target}`,
    worktree: "worktrees/task-000000000641",
    base: "main",
    startCommit: head,
    head,
  });
}

export function effects(rounds = 1) {
  const repeated = <Value>(value: () => Value): Value[] =>
    Array.from({ length: rounds }, value);
  return {
    "github prepare": [prepared()],
    "claude run-turn": repeated(() =>
      completed({ summary: "Merged main.", commit, uncommitted: [] }),
    ),
    "github open-pr": repeated(() =>
      completed({ number: 641, url: "pull/641", commit }),
    ),
    "github wait-review": repeated(() =>
      completed({
        number: 641,
        commit,
        score: 5,
        summary: "Good",
        findings: [],
      }),
    ),
    "claude run-turn:review": repeated(() =>
      completed({ summary: "Reviewed.", reviewVerdict: "accept" }),
    ),
    "github merge": [completed({ number: 641, commit, merged: "merged" })],
    "github close-issue": [completed({ number: 627 })],
  };
}

export function approvals(rounds = 1) {
  const round = (selection.accept === "person" ? ["accept"] : []).concat(
    selection.merge === "person" ? ["merge"] : [],
  );
  return Array.from({ length: rounds }, () => round)
    .flat()
    .map(() => ({ decision: "approved" as const, answer: null }));
}

export function failedMerges(reasons: readonly string[]) {
  return reasons
    .map((reason) => completed({ reason, output: `Output of ${reason}.` }))
    .concat([completed({ number: 641, commit, merged: "merged" })]);
}

export function prompts(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === "run-turn"
      ? [request[1].payload]
      : [],
  );
}

export function accepted(): readonly string[] {
  const accept = {
    greptile: ["wait-review"],
    person: ["waitForDecision"],
    turn: ["run-turn:review"],
  }[selection.accept];
  return (accept ?? []).concat(
    selection.merge === "person" ? ["waitForDecision"] : [],
  );
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
  return requests.flatMap((request): unknown[] => {
    if (request[0] !== "effect" || request[1].method !== method) return [];
    const value: unknown = JSON.parse(request[1].payload);
    return [value];
  });
}
