import assert from "node:assert/strict";
import { test } from "node:test";
import { field, ran, request } from "./develop-workflow-fixture.ts";

const input = {
  cycleId: "prd-75",
  ticket: "Show the cost of each run on the watch page",
};
const operations = [
  "github-prepare",
  "claude-research",
  "claude-review",
  "github-create-issue",
  "github-discard",
];

function completed(result: unknown): unknown {
  return {
    kind: "completed",
    operationId: "operation",
    receipt: "receipt",
    result: JSON.stringify(result),
  };
}

function scenario(
  created: unknown,
  effects: Readonly<Record<string, readonly unknown[]>> = {},
): unknown {
  return {
    workflow: "develop-prd",
    input,
    effects: {
      "github prepare": [completed({})],
      "claude run-turn": [completed({}), completed({})],
      "github create-issue": [created],
      "github discard": [completed({})],
      ...effects,
    },
  };
}

await test("CLV-075 researches, reviews, posts and discards in order", async () => {
  const [line] = await ran([
    scenario(
      completed({ number: 75, url: "https://github.com/acme/demo/issues/75" }),
    ),
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "issue-75",
  });
  assert.deepEqual(
    operations.map((_, index) =>
      field(field(request(line, index), "scope"), "operation"),
    ),
    operations,
  );
  checkPrompts(line);
});

function checkPrompts(line: unknown): void {
  const research = String(field(request(line, 1), "payload"));
  assert.ok(research.includes(input.ticket));
  for (const text of [
    "code",
    "web",
    "# <title>",
    "Problem",
    "Desired outcome",
    "Concrete scenario",
    "Scope",
    "Non-goals",
    "Acceptance criteria",
    "TDD entry points",
    "Dependencies",
    "Sources",
    "Do not commit",
    "do not push",
  ])
    assert.ok(research.includes(text), text);
  const payload: unknown = JSON.parse(
    String(field(request(line, 3), "payload")),
  );
  const draft = String(field(payload, "draft"));
  assert.ok(research.includes(draft));
  const review = String(field(request(line, 2), "payload"));
  for (const text of [
    draft,
    "each claim",
    "code",
    "local paths",
    "private names",
    "secrets",
    "GitHub logins",
    "other repositories",
  ])
    assert.ok(review.includes(text), text);
}

await test("CLV-075 a refused post blocks the run and preserves the draft", async () => {
  const [line] = await ran([
    scenario({
      kind: "failed",
      operationId: "operation",
      reason: "private-path-in-change",
    }),
  ]);
  assert.deepEqual(field(line, "outcome"), {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "private-path-in-change",
    evidenceId: "github-create-issue",
  });
  assert.equal(field(field(line, "requests"), "length"), 4);
});

await test("CLV-075 invalid issue results block handoff and preserve the draft", async () => {
  const invalid = [
    null,
    [],
    {},
    "75",
    75,
    true,
    ...[null, "75", 0, -1, 1.5, 9007199254740992].map((number) => ({ number })),
  ];
  const results = [
    ...invalid.map(completed),
    { kind: "completed", operationId: "operation", receipt: "receipt" },
    {
      kind: "completed",
      operationId: "operation",
      receipt: "receipt",
      result: "not json",
    },
  ];
  const lines = await ran(results.map((result) => scenario(result)));
  for (const line of lines) {
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "invalid-issue-result",
      evidenceId: "github-create-issue",
    });
    assert.equal(field(field(line, "requests"), "length"), 4);
  }
});

await test("CLV-075 every incomplete step blocks the workflow without later effects", async () => {
  const created = completed({ number: 75 });
  const failed = { kind: "failed", operationId: "operation", reason: null };
  const refused = { kind: "refused", reason: "budget-exhausted" };
  const cases = [
    scenario(created, { "github prepare": [failed] }),
    scenario(created, { "claude run-turn": [refused] }),
    scenario(created, { "claude run-turn": [completed({}), refused] }),
    scenario(created, { "github discard": [failed] }),
  ];
  const lines = await ran(cases);
  const expected = [
    { operation: "github-prepare", reason: "failed", count: 1 },
    { operation: "claude-research", reason: "budget-exhausted", count: 2 },
    { operation: "claude-review", reason: "budget-exhausted", count: 3 },
    { operation: "github-discard", reason: "failed", count: 5 },
  ];
  for (const [index, line] of lines.entries()) {
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: expected[index]?.reason,
      evidenceId: expected[index]?.operation,
    });
    assert.equal(
      field(field(line, "requests"), "length"),
      expected[index]?.count,
    );
  }
});
