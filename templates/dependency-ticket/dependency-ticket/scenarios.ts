import type { ScenarioRequest } from "cloving/workflows/testing";

export const text =
  "# Upgrade minimist to 1.2.8 for the critical advisories of minimist\n\n## Problem\n\nGHSA-xvch-5gv4-984h\n";
export const input = { cycleId: "ticket-1", input: { text } };

export function completed(value: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

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

export function effects(
  requests: readonly ScenarioRequest[],
): readonly (readonly [string, unknown])[] {
  return requests.flatMap((request) => {
    if (request[0] !== "effect") return [];
    const payload: unknown = JSON.parse(request[1].payload);
    return [[request[1].method, payload] as const];
  });
}
