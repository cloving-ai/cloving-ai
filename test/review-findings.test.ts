import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "../src/testing.ts";
import { reviewByAgent } from "../src/steps/review-by-agent.ts";
import { reviewByPerson } from "../src/steps/review-by-person.ts";

const commit = "a".repeat(40);
const subject = { target: "ticket-1", commit, number: 42 };

function completed(result: unknown) {
  return {
    kind: "completed" as const,
    operationId: "review",
    receipt: null,
    result: JSON.stringify(result),
  };
}

await test("CLV-300 a Greptile review counts its findings apart from its summary", async () => {
  const counts = [];
  for (const findings of [[], [{ path: "a.ts", line: 3, body: "Fix it." }]]) {
    using bridge = fakeStepBridge({
      effects: {
        "github wait-review": [
          completed({
            number: 42,
            commit,
            score: 3,
            summary: "Risky.",
            findings,
          }),
        ],
      },
    });
    const review = await reviewByAgent({
      subject,
      reviewer: { kind: "greptile" },
    });
    counts.push([review.feedback, review.findings, bridge.requests.length]);
  }
  assert.deepEqual(counts, [
    ["Risky.", 0, 1],
    ["Risky.\n\na.ts:3\nFix it.", 1, 1],
  ]);
});

await test("CLV-300 a turn review counts a change report as one finding", async () => {
  const counts = [];
  for (const result of [
    { summary: "Fix the race.", reviewVerdict: "change" },
    { summary: "", reviewVerdict: "change" },
    { summary: "Ready.", reviewVerdict: "accept" },
    { summary: "Fix the race.", reviewVerdict: null },
  ]) {
    using bridge = fakeStepBridge({
      effects: { "claude run-turn:checker": [completed(result)] },
    });
    const review = await reviewByAgent({
      subject,
      reviewer: { kind: "turn", profile: "checker" },
    });
    counts.push([review.findings, bridge.requests.length]);
  }
  assert.deepEqual(counts, [
    [1, 1],
    [0, 1],
    [0, 1],
    [0, 1],
  ]);
});

await test("CLV-300 a person review counts a denial with an answer as one finding", async () => {
  const counts = [];
  for (const decision of [
    { decision: "denied" as const, answer: "Fix the race." },
    { decision: "denied" as const, answer: " " },
    { decision: "approved" as const, answer: "Ready." },
  ]) {
    using bridge = fakeStepBridge({ decisions: [decision] });
    const review = await reviewByPerson({ subject });
    counts.push([review.findings, bridge.requests.length]);
  }
  assert.deepEqual(counts, [
    [1, 1],
    [0, 1],
    [0, 1],
  ]);
});
