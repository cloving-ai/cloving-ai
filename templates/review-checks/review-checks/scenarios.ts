import type { ScenarioRequest } from "cloving/workflows/testing";

export const input = { cycleId: "checks-1", input: {} };

export function completed(value: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

export function link(pullRequest: number, thread: number): string {
  return `https://github.com/acme/demo/pull/${String(pullRequest)}#discussion_r${String(thread)}`;
}

export function comment(pullRequest: number, thread: number) {
  return {
    pullRequest,
    path: "src/queue.ts",
    line: thread,
    author: "greptile-apps[bot]",
    bot: true,
    text: "This promise is not awaited inside the loop.",
    url: link(pullRequest, thread),
  };
}

export const threeThreads = [comment(641, 1), comment(641, 2), comment(643, 3)];

export function facts(fields: Readonly<Record<string, unknown>> = {}) {
  return {
    since: "2026-10-31T07:00:00Z",
    comments: threeThreads.concat(
      Object.assign(comment(650, 4), { line: null, bot: false }),
    ),
    lintRules: { "no-console": "error", "no-await-in-loop": "off" },
    qualityChecks: ["clones", "structure"],
    openTickets: [
      {
        number: 702,
        title: "An issue with no check line",
        url: "https://github.com/acme/demo/issues/702",
        check: null,
      },
    ],
    decisions: [],
    ...fields,
  };
}

export function suggestion(fields: Readonly<Record<string, unknown>> = {}) {
  return {
    name: "await-in-loop",
    shape: "A promise that a loop starts and never awaits.",
    links: threeThreads.map((item) => item.url),
    kind: "enable-rule",
    rule: "no-await-in-loop",
    hits: 4,
    countCommand: "npx eslint --rule 'no-await-in-loop: error' src",
    scope: "changed",
    ...fields,
  };
}

export function turn(suggestions: readonly unknown[]) {
  return completed({ summary: JSON.stringify({ suggestions }) });
}

export function issue(number: number) {
  return completed({
    number,
    url: `https://github.com/acme/demo/issues/${String(number)}`,
  });
}

export function effects(
  given: unknown,
  suggestions: readonly unknown[] = [suggestion()],
) {
  return {
    "command run:review-comments": [completed(given)],
    "github prepare": [completed({ worktree: "tree", base: "main" })],
    "claude run-turn": [turn(suggestions)],
    "github discard": [completed({ discarded: "cloving/checks-1" })],
    "command run:review-checks-record": [
      completed({ recorded: suggestions.length }),
    ],
  };
}

export function methods(requests: readonly ScenarioRequest[]) {
  return requests.map((request) =>
    request[0] === "effect" ? request[1].method : request[0],
  );
}

export function recordedDecisions(
  requests: readonly ScenarioRequest[],
): string[] {
  return requests.flatMap((request) => {
    if (request[0] !== "effect") return [];
    if (request[1].method !== "run:review-checks-record") return [];
    const value: unknown = JSON.parse(request[1].payload);
    const listed =
      typeof value === "object" && value !== null && "decisions" in value
        ? value.decisions
        : [];
    return (Array.isArray(listed) ? listed : []).map((item: unknown) =>
      JSON.stringify(item).replace(
        /^\{"name":"([^"]+)".*"decision":"([^"]+)".*$/,
        "$1 $2",
      ),
    );
  });
}

export function tickets(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) => {
    if (request[0] !== "handoff") return [];
    const text = request[1].input["text"];
    return typeof text === "string" ? [text] : [];
  });
}

export function payloads(
  requests: readonly ScenarioRequest[],
  method: string,
): unknown[] {
  return requests.flatMap((request) => {
    if (request[0] !== "effect" || request[1].method !== method) return [];
    const value: unknown = JSON.parse(request[1].payload);
    return [value];
  });
}

export function prompts(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) => {
    if (request[0] === "waitForDecision") return [request[1].prompt];
    return request[0] === "effect" && request[1].method === "run-turn"
      ? [request[1].payload]
      : [];
  });
}

const refusalFailed = {
  kind: "failed" as const,
  operationId: "op",
  reason: "command-exit",
};
export const refusals = [
  [
    { decisions: [{ decision: "answered", answer: "accept defer" }] },
    "invalid-check-answer",
    "waitForDecision",
  ],
  [
    { decisions: [{ decision: "answered", answer: "maybe" }] },
    "invalid-check-answer",
    "waitForDecision",
  ],
  [
    { decisions: [{ decision: "denied", answer: null }] },
    "check-question-not-answered",
    "waitForDecision",
  ],
  [
    {
      effects: {
        "claude run-turn": [completed({ summary: "x".repeat(12001) })],
      },
    },
    "check-suggestions-too-large",
    "discard",
  ],
  [
    {
      suggestions: [suggestion({ shape: "Each @ts-ignore needs a reason." })],
    },
    "invalid-check-suggestions",
    "discard",
  ],
  [
    { suggestions: [suggestion({ scope: "some" })] },
    "invalid-check-suggestions",
    "discard",
  ],
  [
    { facts: facts({ lintRules: { "no-console": 2 } }) },
    "invalid-review-comments",
    "run:review-comments",
  ],
  [
    {
      facts: facts({
        comments: [Object.assign(comment(641, 1), { bot: "yes" })],
      }),
    },
    "invalid-review-comments",
    "run:review-comments",
  ],
  [
    { facts: facts({ comments: [{ pullRequest: 0 }] }) },
    "invalid-review-comments",
    "run:review-comments",
  ],
  [
    {
      effects: {
        "claude run-turn": [Object.assign(completed(0), { result: "{" })],
      },
    },
    "invalid-check-suggestions",
    "discard",
  ],
  [
    { effects: { "claude run-turn": [completed({ summary: "[" })] } },
    "invalid-check-suggestions",
    "discard",
  ],
  [
    { suggestions: [suggestion({ kind: "other", hits: -1 })] },
    "invalid-check-suggestions",
    "discard",
  ],
  [
    { suggestions: [suggestion({ hits: -1 })] },
    "invalid-check-suggestions",
    "discard",
  ],
  [{ facts: [] }, "invalid-review-comments", "run:review-comments"],
  [
    { facts: facts({ comments: {} }) },
    "invalid-review-comments",
    "run:review-comments",
  ],
  [
    {
      facts: facts({
        decisions: [{ name: "x", shape: "", decision: "maybe", links: [] }],
      }),
    },
    "invalid-review-comments",
    "run:review-comments",
  ],
  [
    { effects: { "command run:review-comments": [refusalFailed] } },
    "command-exit",
    "run:review-comments",
  ],
  [
    {
      effects: {
        "command run:review-checks-record": [completed({ recorded: 0 })],
      },
    },
    "invalid-record-result",
    "run:review-checks-record",
  ],
] as const;
