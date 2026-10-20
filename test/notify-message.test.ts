import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionLines } from "../src/cli/render.ts";
import {
  decisionNotification,
  outcomeNotification,
} from "../src/daemon/notify-message.ts";

const run = { runId: "run-one", workflowId: "develop-ticket" };
const question = {
  decisionId: "run-one/design-1",
  label: "Q1",
  type: "question",
  prompt: "Which design?",
  allowed: ["answer"],
  revision: 1,
  generation: 2,
  subjectDigest: "subject",
  feedback: [{ decisionId: "prior", text: "Please simplify." }],
};

await test("CLV-090 notification text matches questions, including question commands and feedback", () => {
  const notification = decisionNotification(run, question);
  assert.equal(notification.message.body, decisionLines(question).join("\n"));
  assert.equal(notification.key, "decision:run-one/design-1");
  assert.match(notification.message.body, /cloving answer Q1 --text <answer>/);
  assert.match(
    notification.message.body,
    /Feedback of prior: Please simplify\./,
  );
  assert.doesNotMatch(notification.message.body, /cloving (approve|deny)/);
});

await test("CLV-090 long feedback and failure reasons are bounded without clipping the command", () => {
  const decision = decisionNotification(run, {
    ...question,
    feedback: [{ decisionId: "prior", text: "f".repeat(8000) }],
  });
  assert.equal(decision.message.body.length, 4000);
  assert.ok(
    decision.message.body.endsWith(String(decisionLines(question).at(-1))),
  );
  const failed = outcomeNotification({
    ...run,
    state: "failed",
    reason: { code: "failure", detail: "r".repeat(8000) },
  });
  assert.equal(failed?.message.body.length, 4000);
  assert.ok(failed.message.body.endsWith("cloving status run-one"));
  assert.equal(failed.key, "failed:run-one");
  assert.equal(outcomeNotification({ ...run, state: "cancelled" }), undefined);
});

await test("CLV-090 decisions without allowed commands stay bounded and subjects stay on one line", () => {
  const notice = decisionNotification(
    { ...run, workflowId: "one\ntwo\rthree" },
    { ...question, allowed: null },
  );
  assert.doesNotMatch(notice.message.subject, /[\n\r]/);
  assert.doesNotMatch(notice.message.body, /cloving answer/);
});

await test("CLV-148 automatic analysis notifications keep question text private and retain the answer binding", () => {
  const prompt = "private synthetic analysis question";
  const notification = decisionNotification(
    { ...run, workflowId: "analyze-chats" },
    { ...question, prompt, feedback: [{ text: prompt }] },
  );
  assert.equal(JSON.stringify(notification).includes(prompt), false);
  assert.match(notification.message.body, /cloving questions/);
  assert.match(notification.message.body, /--subject-digest subject/);
  assert.match(notification.message.body, /cloving answer Q1/);
});
