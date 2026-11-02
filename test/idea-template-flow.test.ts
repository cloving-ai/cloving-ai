import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario, type ScenarioRequest } from "../src/testing.ts";
import { effects } from "../templates/idea-to-issue/idea-to-issue/scenarios.ts";

const completed = (result: string | null = null) => ({
  kind: "completed" as const,
  operationId: "operation",
  receipt: null,
  result,
});

for (const labelFails of [false, true])
  await test(`CLV-222 a failed handoff queues its issue and reports label failure ${String(labelFails)}`, async () => {
    const result = await runScenario({
      workflow: new URL(
        "../templates/idea-to-issue/idea-to-issue.ts",
        import.meta.url,
      ).href,
      exportName: "ideaToIssue",
      input: { cycleId: "idea-1", input: { idea: "Show costs." } },
      effects: {
        ...effects(),
        handoff: [
          {
            kind: "failed",
            operationId: "handoff",
            reason: "handoff-start-timeout",
          },
        ],
        "github label": [
          labelFails
            ? { kind: "failed", operationId: "label", reason: "label-failed" }
            : completed(),
        ],
      },
    });
    assert.deepEqual(result.outcome, {
      kind: "handoff_requested",
      cycleId: "idea-1",
      promotionId: "issue-42",
      reason: "handoff-start-timeout",
      ...(labelFails ? { issueUpdate: "failed" } : {}),
    });
    assert.equal(result.requests.at(-1)?.[0], "effect");
    const label = result.requests.find(
      (request) => request[0] === "effect" && request[1].method === "label",
    );
    assert.ok(label && label[0] === "effect");
    assert.deepEqual(JSON.parse(label[1].payload), {
      owner: "acme",
      repository: "demo",
      number: 42,
      add: ["cloving: ready"],
      remove: [],
    });
  });

await test("CLV-222 the default researches, corrects, posts and hands off to the repository develop workflow", async () => {
  const result = await runScenario({
    workflow: new URL(
      "../templates/idea-to-issue/idea-to-issue.ts",
      import.meta.url,
    ).href,
    exportName: "ideaToIssue",
    input: { cycleId: "idea-1", input: { idea: "Show run costs." } },
    effects: {
      "github prepare": [completed()],
      "claude run-turn": [completed(), completed()],
      "github create-issue": [
        completed(
          JSON.stringify({
            number: 42,
            url: "https://github.com/acme/demo/issues/42",
          }),
        ),
      ],
      "github discard": [completed()],
    },
  });
  assert.deepEqual(result.outcome, {
    kind: "handoff_requested",
    cycleId: "idea-1",
    promotionId: "issue-42",
  });
  assert.deepEqual(
    result.requests.map((request) =>
      request[0] === "effect" ? request[1].method : request[0],
    ),
    ["prepare", "run-turn", "run-turn", "create-issue", "handoff", "discard"],
  );
  const handoff = result.requests[4];
  assert.deepEqual(handoff, [
    "handoff",
    { workflowId: "develop", input: { ticket: "42" } },
  ]);
  const post = result.requests[3];
  assert.ok(post && post[0] === "effect");
  assert.deepEqual(JSON.parse(post[1].payload), {
    draft: "cloving-prd-draft.md",
  });
  checkPrompts(result.requests);
});

function checkPrompts(requests: readonly ScenarioRequest[]): void {
  const research = requests[1];
  assert.ok(research && research[0] === "effect");
  for (const text of [
    "Show run costs.",
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
    "cloving-prd-draft.md",
  ])
    assert.ok(research[1].payload.includes(text), text);
  const review = requests[2];
  assert.ok(review && review[0] === "effect");
  for (const text of [
    "every claim",
    "cloving-prd-draft.md",
    "code",
    "local paths",
    "private names",
    "secrets",
    "GitHub logins",
    "other repositories",
  ])
    assert.ok(review[1].payload.includes(text), text);
}
