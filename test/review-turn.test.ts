import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { reviewByAgent } from "../src/steps/review-by-agent.ts";
import { reviewByPerson } from "../src/steps/review-by-person.ts";
import { reviewReport, reviewReportStream } from "../src/review-subject.ts";
import { withFiles } from "./quality/files-fixture.ts";

const commit = "a".repeat(40);
const subject = { target: "ticket-1", commit };

await test("CLV-220 a named review turn returns change feedback with the common person result", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "claude run-turn:checker": [
        {
          kind: "completed",
          operationId: "review",
          receipt: null,
          result: JSON.stringify({
            summary: "Fix the race.",
            reviewVerdict: "change",
          }),
        },
      ],
    },
    decisions: [{ decision: "denied", answer: "Fix the race." }],
  });
  const result = await reviewByAgent({
    subject,
    reviewer: { kind: "turn", profile: "checker" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.feedback, "Fix the race.");
  assert.deepEqual(result, await reviewByPerson({ subject }));
  const request = bridge.requests[0];
  assert.ok(request?.[0] === "effect");
  assert.equal(request[1].method, "run-turn:checker");
  assert.equal(request[1].target, subject.target);
  assert.equal(request[1].units, 1);
  assert.match(request[1].payload, new RegExp(commit));
  assert.match(request[1].payload, /Review verdict: accept/);
  assert.match(request[1].payload, /Review verdict: change/);
});

await test("CLV-220 turn review scenarios isolate changed drafts and snapshot the reviewer", () =>
  withFiles(
    {
      "review.mjs": `import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";
export async function review(subject) {
  return await reviewByAgent({ subject, reviewer: { kind: "turn", profile: "checker" } });
}`,
    },
    async (root) => {
      const outcomes = [];
      for (const draft of ["First draft", "Changed draft"]) {
        const result = await runScenario({
          workflow: join(root, "review.mjs"),
          exportName: "review",
          input: { draft },
          effectLimit: 1,
          effects: {
            "claude run-turn:checker": [
              turnResult({ summary: "Ready.", reviewVerdict: "accept" }),
            ],
          },
        });
        assert.partialDeepStrictEqual(result.outcome, {
          accepted: true,
          feedback: "Ready.",
          commit: null,
        });
        assert.equal(result.spent, 1);
        outcomes.push(result.outcome);
        assert.equal(result.requests.length, 1);
      }
      assert.notDeepEqual(outcomes[0], outcomes[1]);
      using bridge = fakeStepBridge({
        effects: {
          "claude run-turn:checker": [
            turnResult({ summary: "Ready.", reviewVerdict: "accept" }),
          ],
        },
      });
      const reviewer = { kind: "turn" as const, profile: "checker" };
      const mutable = { draft: "Original" };
      const waiting = reviewByAgent({ subject: mutable, reviewer });
      mutable.draft = "Changed while waiting";
      reviewer.profile = "fixer";
      assert.equal((await waiting).accepted, true);
      const request = bridge.requests[0];
      assert.ok(request?.[0] === "effect");
      assert.equal(request[1].method, "run-turn:checker");
      assert.match(request[1].payload, /Original/);
      assert.doesNotMatch(request[1].payload, /Changed while waiting/);
    },
  ));

function turnResult(result: unknown) {
  return {
    kind: "completed" as const,
    operationId: "review",
    receipt: null,
    result: JSON.stringify(result),
  };
}

for (const result of [
  null,
  { summary: null, reviewVerdict: "accept" },
  { summary: "Ready.", reviewVerdict: ["accept"] },
  { summary: "Ready.", reviewVerdict: "unknown" },
])
  await test(`CLV-220 turn review rejects malformed verdict data ${JSON.stringify(result)}`, async () => {
    using bridge = fakeStepBridge({
      effects: { "claude run-turn:checker": [turnResult(result)] },
    });
    await assert.rejects(
      reviewByAgent({
        subject,
        reviewer: { kind: "turn", profile: "checker" },
      }),
      { message: "invalid-review-result" },
    );
    assert.equal(bridge.requests.length, 1);
  });

await test("CLV-220 failed turns and exhausted budgets cannot accept a review", async () => {
  for (const reason of [
    "unknown-profile",
    "profile-not-allowed",
    "effect-budget-exhausted",
  ]) {
    using bridge = fakeStepBridge({
      effects: {
        "claude run-turn:checker": [
          { kind: "failed", operationId: "review", reason },
        ],
      },
    });
    await assert.rejects(
      reviewByAgent({
        subject,
        reviewer: { kind: "turn", profile: "checker" },
      }),
      { message: reason },
    );
    assert.equal(bridge.requests.length, 1);
  }
});

await test("CLV-220 streamed verdicts agree with full reports for long lines and chunk boundaries", () => {
  const reports = [
    "Review verdict: accept",
    "Feedback.\r\nReview verdict: change\r\n",
    "Review verdict: accept" + " ".repeat(100) + "invalid",
    "Review verdict: change\nMore feedback.",
    "語".repeat(100) + "\nReview verdict: accept\n\n",
    "Feedback only.",
    "",
  ];
  for (const text of reports) {
    for (const size of [1, 7, 32]) {
      const stream = reviewReportStream(128);
      for (let index = 0; index < text.length; index += size)
        stream.write(text.slice(index, index + size));
      assert.equal(
        stream.result().reviewVerdict,
        reviewReport(text).reviewVerdict,
        text,
      );
    }
  }
});

await test("CLV-220 a review turn with no verdict declines with fixed feedback", async () => {
  using bridge = fakeStepBridge({
    effects: {
      "claude run-turn:checker": [
        {
          kind: "completed",
          operationId: "review",
          receipt: null,
          result: JSON.stringify({
            summary: "Looks fine.",
            reviewVerdict: null,
          }),
        },
      ],
    },
  });
  const result = await reviewByAgent({
    subject,
    reviewer: { kind: "turn", profile: "checker" },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.feedback, "The review turn has no verdict line.");
  assert.equal(bridge.requests.length, 1);
});

await test("CLV-220 streamed feedback precedes the final verdict even with a discarded whitespace tail", () => {
  const stream = reviewReportStream(128);
  for (const chunk of [
    "Feedback.\nReview ver",
    "dict: accept\r\n",
    "\n".repeat(60_000),
  ])
    stream.write(chunk);
  assert.deepEqual(stream.result(), {
    reviewVerdict: "accept",
    feedback: "Feedback.",
  });
});
