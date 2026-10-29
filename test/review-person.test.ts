import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import { fakeStepBridge, runScenario } from "../src/testing.ts";
import { reviewByPerson } from "../src/steps/review-by-person.ts";
import { withFiles } from "./quality/files-fixture.ts";

const commit = "a".repeat(40);
const subject = { target: "ticket-1", commit };
const digest = (text: string) =>
  "sha256:" + createHash("sha256").update(text).digest("hex");

await test("CLV-222 a person gate displays the captured draft as readable text", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "approved", answer: null }],
  });
  const draft = "# Costs\n\nShow the cost.\n";
  await reviewByPerson({ subject: { draft } });
  const gate = bridge.requests[0];
  assert.ok(gate && gate[0] === "waitForDecision");
  assert.equal(gate[1].prompt, `Review this subject:\n${draft}`);
});

await test("CLV-222 person gates distinguish the same draft at different commits", async () => {
  using bridge = fakeStepBridge({
    decisions: [
      { decision: "approved", answer: null },
      { decision: "approved", answer: null },
    ],
  });
  const draft = "# Costs\n\nShow the cost.\n";
  const commits = [commit, "b".repeat(40)];
  for (const commit of commits)
    await reviewByPerson({ subject: { draft, commit } });
  assert.deepEqual(
    bridge.requests.map((gate) => {
      assert.equal(gate[0], "waitForDecision");
      return gate[1];
    }),
    commits.map((commit) => ({
      gateId: `review:${digest(
        JSON.stringify(["cloving-review-subject", 1, "draft", commit, draft]),
      )}`,
      kind: "approval",
      prompt: `Review this subject:\n${commit}\n${draft}`,
    })),
  );
});

await test("CLV-220 person reviews return approval in the original workflow call", () =>
  withFiles(
    {
      "review.mjs": `import { reviewByPerson } from "cloving/workflows/steps/review-by-person";
export async function review(subject) {
  return await reviewByPerson({ subject });
}`,
    },
    async (root) => {
      const result = await runScenario({
        workflow: join(root, "review.mjs"),
        exportName: "review",
        input: subject,
        decisions: [{ decision: "approved", answer: null }],
      });
      assert.deepEqual(result.outcome, {
        accepted: true,
        feedback: "",
        commit,
        subjectDigest: digest(
          JSON.stringify([
            "cloving-review-subject",
            1,
            "commit",
            "ticket-1",
            commit,
          ]),
        ),
      });
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0]?.[0], "waitForDecision");
    },
  ));

await test("CLV-220 changed drafts on one commit need a distinct person review", async () => {
  using bridge = fakeStepBridge({
    decisions: [
      { decision: "approved", answer: null },
      { decision: "denied", answer: "Keep the earlier wording." },
    ],
  });
  const first = await reviewByPerson({
    subject: { draft: "First draft", commit },
  });
  const second = await reviewByPerson({
    subject: { draft: "Second draft", commit },
  });
  assert.equal(first.accepted, true);
  assert.equal(first.commit, null);
  assert.equal(second.accepted, false);
  assert.equal(second.commit, null);
  assert.equal(second.feedback, "Keep the earlier wording.");
  assert.notEqual(first.subjectDigest, second.subjectDigest);
  assert.equal(
    first.subjectDigest,
    digest(
      JSON.stringify([
        "cloving-review-subject",
        1,
        "draft",
        commit,
        "First draft",
      ]),
    ),
  );
  assert.equal(bridge.requests.length, 2);
  assert.notEqual(bridge.requests[0]?.[1], bridge.requests[1]?.[1]);
});

await test("CLV-220 a draft snapshot survives mutation of the caller's object", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "approved", answer: null }],
  });
  const draft = { draft: "Original", commit };
  const waiting = reviewByPerson({ subject: draft });
  draft.draft = "Edited while waiting";
  draft.commit = "b".repeat(40);
  const result = await waiting;
  assert.equal(
    result.subjectDigest,
    digest(
      JSON.stringify([
        "cloving-review-subject",
        1,
        "draft",
        commit,
        "Original",
      ]),
    ),
  );
  assert.equal(result.accepted, true);
  assert.match(JSON.stringify(bridge.requests), /Original/);
  assert.doesNotMatch(JSON.stringify(bridge.requests), /Edited while waiting/);
  const gate = bridge.requests[0];
  assert.ok(gate && gate[0] === "waitForDecision");
  assert.equal(gate[1].prompt, `Review this subject:\n${commit}\nOriginal`);
});

await test("CLV-220 invalid subjects never open a person review", async () => {
  using bridge = fakeStepBridge({
    decisions: [{ decision: "approved", answer: null }],
  });
  for (const subject of [
    { commit: "", target: "ticket-1" },
    { commit, target: "" },
    { commit: "HEAD", target: "ticket-1" },
    { draft: "" },
    { draft: "Text", commit: "HEAD" },
  ])
    await assert.rejects(reviewByPerson({ subject }), {
      message: "invalid-review-subject",
    });
  assert.deepEqual(bridge.requests, []);
});
