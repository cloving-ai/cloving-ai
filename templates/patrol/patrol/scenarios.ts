import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { act: "ask" };
export const input = { cycleId: "patrol-1", input: {} };

export function stuck(number: number, fields: Record<string, unknown> = {}) {
  return {
    number,
    branch: `cloving/task-${String(number).padStart(12, "0")}`,
    state: "blocked",
    active: false,
    reason: "merge-conflict",
    head: "a".repeat(40),
    score: 4,
    issue: "acme/demo#627",
    ticketStatus: "complete",
    ...fields,
  };
}

export function completed(value: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

export function status(pulls: readonly unknown[]) {
  return { "command run:patrol-status": [completed(pulls)] };
}

export function methods(requests: readonly ScenarioRequest[]) {
  return requests.map((request) =>
    request[0] === "effect" ? request[1].method : request[0],
  );
}

export function handoffs(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request) =>
    request[0] === "handoff" ? [request[1]] : [],
  );
}

export function answers(answer: string) {
  return selection.act === "ask"
    ? [{ decision: "answered" as const, answer }]
    : [];
}

export function asked(): readonly string[] {
  return selection.act === "ask" ? ["waitForDecision"] : [];
}
