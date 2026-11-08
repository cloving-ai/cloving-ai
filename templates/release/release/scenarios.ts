import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { accept: "greptile", publish: "person" };
export const commit = "b".repeat(40);
export const merged = "c".repeat(40);
export const input = {
  cycleId: "release-1",
  repository: "main-checkout",
  input: { version: "1.7.0", pullRequests: "641, #643" },
};

type JsonValue =
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function completed(result: JsonValue) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(result),
  };
}

export const pending = {
  kind: "pending" as const,
  deadline: 0,
  nextCheckAt: 0,
};

export function ready(value: JsonValue) {
  return { kind: "ready" as const, value };
}

export function pullStates(states: readonly (readonly [number, string])[]) {
  return ready({
    pulls: states.map(([number, state]) => ({ number, state })),
  });
}

export const notes =
  "- Add the release template (#641).\n- Fix the queue (#643).";

export function reported(
  summary = `Set the version 1.7.0.\n\nRelease notes:\n${notes}`,
) {
  return completed({ summary, commit, uncommitted: [] });
}

export function effects(rounds = 1) {
  const repeated = <Value>(value: () => Value): Value[] =>
    Array.from({ length: rounds }, value);
  return {
    "github prepare": [
      completed({
        branch: "cloving/release-1",
        worktree: "worktrees/release-1",
        base: "main",
        startCommit: "a".repeat(40),
      }),
    ],
    "claude run-turn": repeated(() => reported()),
    "github open-pr": repeated(() =>
      completed({ number: 650, url: "pull/650", commit }),
    ),
    "github wait-review": repeated(() =>
      completed({
        number: 650,
        commit,
        score: 5,
        summary: "Good",
        findings: [],
      }),
    ),
    "claude run-turn:review": repeated(() =>
      completed({ summary: "Reviewed.", reviewVerdict: "accept" }),
    ),
    "github merge": [completed({ number: 650, commit, merged })],
    "command run:push-tag": [completed({ tag: "v1.7.0", commit: merged })],
  };
}

export function waits(status: JsonValue = { state: "published" }) {
  return {
    "release-pulls": [
      pending,
      pullStates([
        [641, "merged"],
        [643, "merged"],
      ]),
    ],
    "release-status": [pending, ready(status)],
  };
}

type Decision = {
  readonly decision: "approved" | "denied";
  readonly answer: string | null;
};

export function approvals(rounds = 1): Decision[] {
  const accepted = Array.from({ length: rounds }, () =>
    selection.accept === "person" ? ["accept"] : [],
  ).flat();
  return accepted
    .concat(selection.publish === "person" ? ["publish"] : [])
    .map(() => ({ decision: "approved", answer: null }));
}

export function denials(rounds = 1): Decision[] {
  const decisions = approvals(rounds);
  if (selection.publish !== "person") return decisions;
  return decisions
    .slice(0, -1)
    .concat([{ decision: "denied", answer: "Not today." }]);
}

export function accepted(): readonly string[] {
  const accept = {
    greptile: ["wait-review"],
    person: ["waitForDecision"],
    turn: ["run-turn:review"],
  }[selection.accept];
  return accept ?? [];
}

export function asked(): readonly string[] {
  return selection.publish === "person" ? ["waitForDecision"] : [];
}

export function methods(requests: readonly ScenarioRequest[]) {
  return requests.map((request) => {
    if (request[0] === "effect") return request[1].method;
    if (request[0] === "waitForCommand") return `wait ${request[1].name}`;
    return request[0];
  });
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

export function prompts(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === "run-turn"
      ? [request[1].payload]
      : [],
  );
}

export function waitInputs(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request) =>
    request[0] === "waitForCommand" ? [request[1]] : [],
  );
}

export function decisionPrompts(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request) =>
    request[0] === "waitForDecision" ? [request[1].prompt] : [],
  );
}

export function rejectedReview() {
  const base = effects(2);
  const denied: Decision[] =
    selection.accept === "person"
      ? [{ decision: "denied", answer: "Fix the notes." }]
      : [];
  return {
    effects: Object.assign(base, {
      "github wait-review": [
        completed({
          number: 650,
          commit,
          score: 4,
          summary: "Fix the notes.",
          findings: [],
        }),
      ].concat(base["github wait-review"].slice(1)),
      "claude run-turn:review": [
        completed({ summary: "Fix the notes.", reviewVerdict: "change" }),
      ].concat(base["claude run-turn:review"].slice(1)),
    }),
    decisions: denied.concat(approvals(1)),
  };
}
