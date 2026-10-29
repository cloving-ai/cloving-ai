export const selection = { review: "turn", post: "privacy", next: "develop" };
export const input = { cycleId: "idea-1", input: { idea: "Show run costs." } };
export const text = "# Run costs\n\nShow the cost.\n";
export const digest = `sha256:${"a".repeat(64)}`;
export const readyLabel = {
  owner: "acme",
  repository: "demo",
  number: 42,
  add: ["cloving: ready"],
  remove: [],
};

export function completed(
  result: Readonly<Record<string, unknown>> | null = null,
) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(result),
  };
}

export function effects() {
  return {
    "github prepare": [completed()],
    "claude run-turn": [completed(), completed()],
    "github capture-draft": [
      completed({ text, digest }),
      completed({ text, digest }),
    ],
    "github create-issue": [
      completed({ number: 42, url: "https://github.com/acme/demo/issues/42" }),
    ],
    "github label": [completed()],
    "github discard": [completed()],
  };
}
import type { ScenarioRequest } from "cloving/workflows/testing";

export function effectPayloads(
  requests: readonly ScenarioRequest[],
  method: string,
): unknown[] {
  return requests.flatMap((request) => {
    if (request[0] !== "effect" || request[1].method !== method) return [];
    const payload: unknown = JSON.parse(request[1].payload);
    return [payload];
  });
}
