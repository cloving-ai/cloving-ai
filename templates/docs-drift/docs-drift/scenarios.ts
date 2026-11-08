import type { ScenarioRequest } from "cloving/workflows/testing";

export const input = { cycleId: "drift-1", input: {} };

export const commit = "0123456789abcdef0123456789abcdef01234567";

export function completed(value: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

export function candidate(
  doc: string,
  fields: Readonly<Record<string, unknown>> = {},
) {
  return {
    doc,
    since: null,
    code: ["src/settings.ts"],
    codeCount: 1,
    ...fields,
  };
}

export function scan(
  candidates: readonly unknown[],
  fields: Readonly<Record<string, unknown>> = {},
) {
  return { commit, candidates, more: 0, ...fields };
}

export function row(fields: Readonly<Record<string, unknown>> = {}) {
  return {
    line: 42,
    says: "The default of `queue.seconds` is 30.",
    code: "The default of `queue.seconds` is 60.",
    evidence: "src/settings.ts:17",
    commit: "abc1234",
    fix: "Change 30 to 60 on line 42.",
    ...fields,
  };
}

export function turn(result: unknown) {
  return completed({ summary: JSON.stringify(result) });
}

export function effects(
  candidates: unknown,
  result: Readonly<Record<string, unknown>> = { docs: [] },
) {
  return {
    "command run:docs-candidates": [completed(candidates)],
    "github prepare": [completed({ worktree: "tree", base: "main" })],
    "claude run-turn": [turn(result)],
    "github discard": [completed({ discarded: "cloving/drift-1" })],
    "command run:docs-drift-record": [completed({ recorded: 1 })],
  };
}

export const ticket = {
  cycleId: "drift-2",
  input: {
    text: "# Make `README.md` match the code on main\n\n| 42 | 30 | 60 |\n",
  },
};

export function created(number: number) {
  return {
    "github create-issue": [
      completed({
        number,
        url: `https://github.com/acme/demo/issues/${String(number)}`,
      }),
    ],
    "github label": [completed({ number })],
  };
}

export function payloads(requests: readonly ScenarioRequest[]): unknown[] {
  return requests.flatMap((request) =>
    request[0] === "effect"
      ? [[request[1].method, JSON.parse(request[1].payload)]]
      : [],
  );
}

export function methods(requests: readonly ScenarioRequest[]) {
  return requests.map((request) =>
    request[0] === "effect" ? request[1].method : request[0],
  );
}

export function tickets(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) => {
    if (request[0] !== "handoff") return [];
    const text = request[1].input["text"];
    return request[1].workflowId === "docs-drift" && typeof text === "string"
      ? [text]
      : [];
  });
}

export function payloadOf(
  requests: readonly ScenarioRequest[],
  method: string,
): string {
  return requests
    .flatMap((request) =>
      request[0] === "effect" && request[1].method === method
        ? [request[1].payload]
        : [],
    )
    .join("");
}
