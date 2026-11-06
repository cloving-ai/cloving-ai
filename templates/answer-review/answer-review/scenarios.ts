import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { resolve: "bot-fix" };
export const head = "a".repeat(40);
export const pushedCommit = "abc1234" + "b".repeat(33);
export const target = "task-000000000641";
export const input = {
  cycleId: "answer-1",
  repository: "main-checkout",
  input: { pullRequest: 641 },
};

export function completed(result: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(result),
  };
}

export function failed(reason: string) {
  return { kind: "failed" as const, operationId: "operation", reason };
}

export function thread(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    path: "src/a.ts",
    line: 3,
    outdated: false,
    bot: true,
    comments: [
      {
        id: `C_${id}`,
        author: "greptile-apps",
        bot: true,
        body: `Finding of ${id}.`,
        createdAt: "2026-11-06T10:00:00Z",
      },
    ],
    ...fields,
  };
}

export function threads(list: readonly unknown[], comments: unknown[] = []) {
  return completed({
    number: 641,
    head,
    threads: list,
    comments,
    latest: { id: "C_last", at: "2026-11-06T10:00:00Z" },
    answered: null,
    quietSeconds: 600,
  });
}

export function turn(summary: string, commits: readonly string[] = []) {
  return completed({
    summary,
    commit: commits.length === 0 ? head : pushedCommit,
    commits,
    uncommitted: [],
  });
}

export function effects(request: {
  readonly threads: readonly unknown[];
  readonly summary: string;
  readonly commits?: readonly string[];
}) {
  const many = (result: unknown) =>
    Array.from({ length: 10 }, () => completed(result));
  return {
    "github prepare": [
      completed({
        target,
        branch: `cloving/${target}`,
        worktree: `worktrees/${target}`,
        base: "main",
        startCommit: head,
        head,
      }),
    ],
    "github review-threads": [threads(request.threads)],
    "github record-answered": [completed({ number: 641, comment: "C_last" })],
    "claude run-turn": [turn(request.summary, request.commits)],
    "github open-pr": [
      completed({ number: 641, url: "pull/641", commit: pushedCommit }),
    ],
    "github reply-thread": many({ thread: "PRRT", comment: "PRRC_reply" }),
    "github resolve-thread": many({ thread: "PRRT", resolved: true }),
    "github wait-review": [
      completed({
        number: 641,
        commit: pushedCommit,
        score: 5,
        summary: "Good",
        findings: [],
      }),
    ],
  };
}

export function resolved<Item>(items: readonly Item[]): readonly Item[] {
  return selection.resolve === "bot-fix" ? items : [];
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
    const value: unknown =
      method === "run-turn"
        ? request[1].payload
        : JSON.parse(request[1].payload);
    return [value];
  });
}

export function prompts(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) =>
    request[0] === "waitForDecision" ? [request[1].prompt] : [],
  );
}

export const stepFailures = [
  [
    { "github prepare": [failed("pull-request-claimed")] },
    "pull-request-claimed",
  ],
  [
    {
      "github prepare": [
        { kind: "stopped" as const, operationId: "x", reason: null },
      ],
    },
    "stopped",
  ],
  [
    { "github prepare": [completed({ target: "../x", base: "main", head })] },
    "invalid-answer-result",
  ],
  [
    { "github review-threads": [completed({ threads: "none" })] },
    "invalid-review-threads",
  ],
  [{ "github review-threads": [completed([])] }, "invalid-review-threads"],
  [
    { "github review-threads": [threads([thread("PRRT_9", { id: "" })])] },
    "invalid-review-threads",
  ],
  [
    { "github record-answered": [failed("invalid-payload")] },
    "invalid-payload",
  ],
  [
    { "claude run-turn": [completed({ summary: 1, commits: [] })] },
    "invalid-answer-report",
  ],
  [
    {
      "claude run-turn": [{ kind: "refused" as const, reason: "effect-limit" }],
    },
    "effect-limit",
  ],
  [
    { "github open-pr": [completed({ number: 642, commit: pushedCommit })] },
    "pull-request-changed",
  ],
  [
    { "github open-pr": [completed({ number: 641, commit: "HEAD" })] },
    "invalid-answer-result",
  ],
  [
    { "github resolve-thread": [failed("github-call-failed")] },
    resolved(["github-call-failed"]).at(0) ?? "none",
  ],
  [
    {
      "github open-pr": [
        {
          kind: "completed" as const,
          operationId: "x",
          receipt: null,
          result: "{",
        },
      ],
    },
    "answer-failed",
  ],
] as const;
