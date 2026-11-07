import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { review: "turn", next: "queue" };
export const input = { cycleId: "goal-1", input: { goal: "Add run tags." } };
export const digest = `sha256:${"a".repeat(64)}`;
export const approved = [{ decision: "approved" as const, answer: null }];

export function draftText(number: number, needs: readonly number[]): string {
  const lines =
    needs.length === 0
      ? ["None."]
      : needs.map((need) => `Needs draft ${String(need)}`);
  return [
    `# Draft ${String(number)}: Step ${String(number)}`,
    "",
    "## Problem",
    `Step ${String(number)} is missing.`,
    "",
    "## Dependencies",
    "",
  ]
    .concat(lines, [""])
    .join("\n");
}

export function planText(drafts: readonly (readonly number[])[]): string {
  return drafts.map((needs, index) => draftText(index + 1, needs)).join("\n");
}

export const chain = planText([[], [1], [2]]);
export const cycle = planText([[2], [1], []]);

export function completed(result: unknown = null) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(result),
  };
}

export function issue(number: number) {
  return completed({
    number: number,
    url: `https://github.com/acme/demo/issues/${String(number)}`,
  });
}

export function effects(captures: readonly string[]) {
  return {
    "github prepare": [completed()],
    "claude run-turn": [completed(), completed(), completed()],
    "github capture-draft": captures.map((text) =>
      completed({ text: text, digest: digest }),
    ),
    "github create-issue": Array.from({ length: 12 }, (_, index) =>
      issue(101 + index),
    ),
    "github label": Array.from({ length: 12 }, () => completed({})),
    "github discard": [completed()],
  };
}

export function effectRequests(
  requests: readonly ScenarioRequest[],
  method: string,
) {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === method ? [request[1]] : [],
  );
}

export function postedTexts(requests: readonly ScenarioRequest[]): string[] {
  return effectRequests(requests, "create-issue").map((request) => {
    const payload: unknown = JSON.parse(request.payload);
    return typeof payload === "object" &&
      payload !== null &&
      "text" in payload &&
      typeof payload.text === "string"
      ? payload.text
      : "";
  });
}
