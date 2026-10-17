import type {
  WatchDecision,
  WatchModel,
  WatchPhase,
  WatchRun,
  WatchTurn,
} from "../src/cli/watch-render.ts";

export const at = (clock: string): string => `2026-10-13T${clock}.000Z`;
export const shownClock = (clock: string): string =>
  new Date(at(clock)).toLocaleTimeString();
export const noCopy = {
  command: "",
  label: "",
  onCopy: (): void => undefined,
};

export function sampleTurn(changes: Partial<WatchTurn> = {}): WatchTurn {
  return {
    key: "k1",
    operationId: "operation-1",
    usage: {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    },
    runId: "run-1",
    target: "clv-016-a6f7ef47",
    branch: "cloving/clv-016-a6f7ef47",
    worktree: "clv-016-a6f7ef47",
    startedAt: at("21:26:02"),
    endedAt: null,
    activeAt: at("21:30:20"),
    outcome: "in work",
    costUsd: null,
    activity: [],
    commits: [],
    files: [],
    uncommitted: [],
    summary: "",
    ...changes,
  };
}

export const reviewedTurn = sampleTurn({
  endedAt: at("21:33:40"),
  outcome: "completed",
  costUsd: 1.0330776000000002,
  commits: ["9e69feb Reject a <request>"],
  files: [" src/a.ts | 6 ++++++", " 1 file changed, 6 insertions(+)"],
  summary: "I added the check & one test.",
});

export const sampleDecision: WatchDecision = {
  decisionId: "run-1/review-1",
  type: "approval",
  prompt: "Review <b>this</b> & that.",
  approve: 'cloving approve run-1/review-1 --text "yes"',
  deny: "cloving deny run-1/review-1",
};

export function phases(
  states: readonly string[],
  end = "Completed",
): readonly WatchPhase[] {
  const spans = [
    [at("21:26:00"), at("21:26:00")],
    [at("21:26:01"), at("21:26:01")],
    [at("21:26:02"), at("21:33:40")],
    [at("21:33:41"), at("21:35:00")],
    [at("21:35:01"), at("21:35:01")],
  ] as const;
  const names = ["Admitted", "Started", "Claude turn", "Your review", end];
  return names.map((name, index) => {
    const state = states[index] ?? "pending";
    const [startedAt, endedAt] = spans[index] ?? [null, null];
    const closed = state === "done" || (state === "failed" && name === end);
    return {
      name,
      state,
      startedAt: state === "pending" ? null : startedAt,
      endedAt: closed ? endedAt : null,
    };
  });
}

export function sampleRun(changes: Partial<WatchRun> = {}): WatchRun {
  return {
    ticketId: null,
    title: null,
    outcome: null,
    latestAt: null,
    claudeCostUsd: 1.0330776000000002,
    usage: {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    },
    round: 1,
    currentStep: { name: "Your review", startedAt: at("21:33:41") },
    runId: "run-1",
    workflowId: "develop-ticket",
    state: "waiting_gate",
    code: "policy-approval",
    detail: "A person must approve.",
    spent: 1,
    limit: 8,
    decisions: [sampleDecision],
    events: [
      { sequence: 1, recordedAt: at("21:26:00"), type: "run.created" },
      { sequence: 2, recordedAt: at("21:33:41"), type: "gate.opened" },
    ],
    turns: [reviewedTurn],
    phases: phases(["done", "done", "done", "active"]),
    decision: "",
    feedback: [],
    pullRequest: null,
    reviews: [],
    mergeCommit: null,
    ...changes,
  };
}

export function sampleModel(runs: readonly WatchRun[]): WatchModel {
  return {
    updatedAt: at("21:34:41"),
    service: "up",
    workflows: [],
    startWorkflowId: null,
    runs,
  };
}
