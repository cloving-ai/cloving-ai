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

export function quiet(number: number, fields: Record<string, unknown> = {}) {
  return stuck(number, {
    state: "completed",
    reason: null,
    head: null,
    ...fields,
  });
}

export function reviewThread(thread: {
  readonly id: string;
  readonly answered: boolean;
}) {
  return {
    id: thread.id,
    path: "src/a.ts",
    line: 3,
    bot: true,
    answered: thread.answered,
  };
}

export function review(fields: Record<string, unknown> = {}) {
  return completed({
    number: 643,
    head: "c".repeat(40),
    threads: [reviewThread({ id: "PRRT_1", answered: false })],
    comments: [],
    latest: { id: "C_2", at: "2026-11-06T10:00:00Z" },
    quietSeconds: 600,
    ...fields,
  });
}

export function reviewed(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request): unknown[] => {
    if (request[0] !== "effect" || request[1].method !== "review-threads")
      return [];
    const value: unknown = JSON.parse(request[1].payload);
    return [value];
  });
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
