export const commit = "a".repeat(40);
export const input = {
  cycleId: "run-1",
  repository: "main-checkout",
  input: {
    ticket: {
      id: "42",
      text: "# Fix the counter\n\nGitHub issue: acme/demo#42 (open)",
    },
  },
};

export function completed(result: unknown) {
  return {
    kind: "completed" as const,
    operationId: "operation",
    receipt: null,
    result: JSON.stringify(result),
  };
}

export function effects() {
  return {
    "github prepare": [completed({})],
    "github label": [completed({}), completed({})],
    "claude run-turn": [
      completed({ summary: "Implemented.\nTicket status: complete" }),
    ],
    "github open-pr": [completed({ number: 7, url: "pull/7", commit })],
    "github wait-review": [
      completed({ number: 7, commit, score: 5, summary: "Good", findings: [] }),
    ],
    "github merge": [completed({ number: 7, commit, merged: "merged" })],
    "github close-issue": [completed({ number: 42 })],
  };
}

export function partialEffects(
  pullRequest: number,
  remaining: readonly string[],
) {
  return {
    ...effects(),
    "claude run-turn": [
      completed({
        summary: `Remaining:\n${remaining.map((item) => `- ${item}`).join("\n")}\nTicket status: partial`,
      }),
    ],
    "github open-pr": [
      completed({
        number: pullRequest,
        url: `pull/${String(pullRequest)}`,
        commit,
      }),
    ],
    "github wait-review": [
      completed({
        number: pullRequest,
        commit,
        score: 5,
        summary: "Good",
        findings: [],
      }),
    ],
    "github merge": [
      completed({ number: pullRequest, commit, merged: "merged" }),
    ],
    "github partial-issue": [completed({ ticketStatus: "partial" })],
  };
}
