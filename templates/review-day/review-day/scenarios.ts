import type { ScenarioRequest } from "cloving/workflows/testing";

export const selection = { post: "privacy", next: "idea" };
export const input = { cycleId: "review-1", input: {} };
export const report = {
  facts:
    "| Metric | Value | Median | Band | Mark |\n| --- | --- | --- | --- | --- |\n| merge minutes | 30 | 10 | 5–15 | outside |",
  wentWell: "Main CI passed; preserve that quality.",
  wentBadly: "Merge checks waited twice.",
  constraint: "Merge checks account for 70% of wait time.",
  improvementsInProgress: "None.",
  proposals: [],
  watchList: "One escaped fault; watch it.",
  removed: [],
};

export const proposal = {
  id: "merge-time",
  loop: "merge",
  text: "Loop: merge\n\nMerge checks timed out twice: https://github.com/acme/demo/actions/runs/10 and https://github.com/acme/demo/actions/runs/11. Hypothesis: the time limit is too short. One change: give the local merge check time factor 3. Expected effect: fewer timeouts; preserve main CI first-pass share. Check merge timeouts on 2026-11-06 (five days later). Cost: longer waits on real faults. Reverse by restoring factor 1. Failure: timeouts persist or main CI first-pass share drops.",
  evidence: [
    "https://github.com/acme/demo/actions/runs/10",
    "https://github.com/acme/demo/actions/runs/11",
  ],
};

export const reviewIssue = {
  number: 12,
  url: "https://github.com/acme/demo/issues/12",
  title: "Daily loop review",
  body: "# Daily loop review",
  createdAt: "2026-11-06T14:45:00Z",
  labels: ["cloving: review"],
};

export const improvementIssue = {
  number: 8,
  url: "https://github.com/acme/demo/issues/8",
  title: "Give the merge check time factor 3",
  body: "Loop: merge\n\nMeasured change.",
  createdAt: "2026-11-05T10:00:00Z",
  labels: ["cloving: improvement"],
};

export function completed(value: unknown = {}) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(value),
  };
}

export function effects() {
  return {
    "command run:report": [
      completed({ metrics: { mergeMinutes: { value: 30, mark: "outside" } } }),
    ],
    "github issues": [completed([]), completed([])],
    "claude run-turn": [
      completed({ summary: JSON.stringify(report) }),
      completed({ summary: JSON.stringify(report) }),
    ],
    "github create-issue": [
      completed({ number: 9, url: "https://github.com/acme/demo/issues/9" }),
    ],
    "github discard": [completed()],
    "github label": [completed(), completed()],
  };
}

export function methods(requests: readonly ScenarioRequest[]) {
  return requests.map((request) =>
    request[0] === "effect" ? request[1].method : request[0],
  );
}

export function proposalEffects() {
  const draft = {
    ...report,
    proposals: [
      { ...proposal, id: "first", text: "First measured change." },
      proposal,
    ],
  };
  return {
    ...effects(),
    "claude run-turn": [
      completed({ summary: JSON.stringify(draft) }),
      completed({ summary: JSON.stringify(draft) }),
    ],
  };
}
