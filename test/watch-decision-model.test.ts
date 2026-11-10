import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionCommands } from "../src/cli/watch-decision.ts";
import { boardModel, boardRun } from "./watch-board-fixture.ts";

const decision = {
  decisionId: "run-1/review-1",
  type: "approval",
  runId: "run-1",
  prompt: "Review the work.",
  allowed: ["approve", "deny"],
  revision: 1,
  generation: 2,
  subjectDigest: "sha256:abc",
};

const binding =
  "--expected-revision 1 --generation 2 --subject-digest sha256:abc";

await test("CLV-016 the watch model gives each pending decision its approve and deny commands", () => {
  assert.deepEqual(decisionCommands(decision, "cloving"), {
    decisionId: "run-1/review-1",
    type: "approval",
    prompt: "Review the work.",
    openedAt: null,
    reference: "run-1/review-1",
    expectedRevision: 1,
    generation: 2,
    subjectDigest: "sha256:abc",
    replies: ["approve", "deny"],
    approve: `cloving approve run-1/review-1 ${binding}`,
    deny: `cloving deny run-1/review-1 --text "<feedback>" ${binding}`,
    answer: `cloving answer run-1/review-1 --text "<answer>" ${binding}`,
  });
});

await test("CLV-336 a question decision allows only an answer, and a reply that the page does not know is left out", () => {
  const question = {
    ...decision,
    type: "question",
    allowed: ["answer", "escalate", 7],
  };
  assert.deepEqual(decisionCommands(question, "cloving").replies, ["answer"]);
  const broken = decisionCommands(
    { ...decision, allowed: "approve", revision: "1" },
    "cloving",
  );
  assert.deepEqual([broken.replies, broken.expectedRevision], [[], 0]);
});

await test("CLV-336 a question of analyze-chats is private in the model and keeps only its preview text", () => {
  const model = (workflowId: string) =>
    boardModel([boardRun("run-1", { state: "waiting_gate", workflowId })], {
      workflows: [workflowId],
      decisions: [
        { ...decision, type: "question", allowed: ["answer"], prompt: "Q?" },
      ],
    }).runs[0]?.decisions[0];
  const hidden = model("analyze-chats");
  assert.equal(hidden?.private, true);
  assert.equal(
    hidden.prompt,
    "Private analysis question. Run cloving questions to view it.",
  );
  const shown = model("develop");
  assert.equal(shown?.private, undefined);
  assert.equal(shown?.prompt, "Q?");
});
