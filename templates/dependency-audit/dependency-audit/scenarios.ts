import type { ScenarioRequest } from "cloving/workflows/testing";

export const input = { cycleId: "audit-1", input: {} };

export function completed(value: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

export function advisory(id: string, severity = "high") {
  return {
    id,
    severity,
    title: `Advisory ${id} | with a pipe`,
    url: `https://github.com/advisories/${id}`,
    vulnerableRange: "<2.0.0",
    patchedRange: ">=2.0.0",
  };
}

export function candidate(
  name: string,
  fields: Readonly<Record<string, unknown>> = {},
) {
  const advisories = fields["advisories"] ?? [
    advisory(`GHSA-${name.padEnd(4, "x").slice(0, 4)}-aaaa-bbbb`),
  ];
  return {
    name,
    severity: "high",
    direct: false,
    range: "<2.0.0",
    versions: ["1.0.0"],
    effects: [],
    fixAvailable: true,
    advisories,
    advisoryCount: Array.isArray(advisories) ? advisories.length : 0,
    paths: [`parent@3.0.0 > ${name}@1.0.0`],
    pathCount: 1,
    ...fields,
  };
}

export const twoPackages = [
  candidate("minimist", {
    severity: "critical",
    advisories: [
      advisory("GHSA-xvch-5gv4-984h", "critical"),
      advisory("GHSA-vh95-rmgr-6w4m", "high"),
    ],
    paths: ["mkdirp@0.5.1 > minimist@1.0.0", "minimist@1.0.0"],
    pathCount: 3,
  }),
  candidate("undici", {
    advisories: [
      Object.assign(advisory("GHSA-xjj6-f33q-929c"), { patchedRange: null }),
    ],
    versions: ["7.18.0"],
  }),
];

export function group(
  packages: readonly string[],
  fields: Readonly<Record<string, unknown>> = {},
) {
  return {
    packages,
    change: {
      kind: "pin",
      package: packages[0],
      from: "1.0.0",
      to: "2.0.0",
    },
    breakingChanges: [],
    sources: [],
    ...fields,
  };
}

export function turn(plan: unknown) {
  return completed({ summary: JSON.stringify(plan) });
}

export function effects(
  candidates: unknown,
  plan: Readonly<Record<string, unknown>> = {},
) {
  return {
    "command run:audit-candidates": [completed(candidates)],
    "github prepare": [completed({ worktree: "tree", base: "main" })],
    "claude run-turn": [turn(plan)],
    "github discard": [completed({ discarded: "cloving/audit-1" })],
  };
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
    return request[1].workflowId === "dependency-ticket" &&
      typeof text === "string"
      ? [text]
      : [];
  });
}

export function prompt(requests: readonly ScenarioRequest[]): string {
  return requests
    .flatMap((request) =>
      request[0] === "effect" && request[1].method === "run-turn"
        ? [request[1].payload]
        : [],
    )
    .join("");
}
