import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionAlert, runAlert } from "../src/alert-selection.ts";
import { channelMessage } from "../src/channel-message.ts";

const token = "ghp_0123456789abcdefABCDEF0123456789abcd";

function failedRun(title: unknown) {
  const alert = runAlert({
    runId: "run-0123456789",
    workflowId: "develop",
    state: "failed",
    title,
    reason: { code: "turn-failed", detail: `Push of ${token} failed.` },
  });
  assert.ok(alert);
  return alert;
}

await test("CLV-338 channel content masks token patterns and private texts in the title and the detail", () => {
  const message = channelMessage(
    failedRun(`Fix login of Acme Secret with ${token}`),
    ["acme secret"],
  );
  assert.equal(
    message.content,
    "Run run-0123… (Fix login of [hidden] with [hidden]) failed: Push of [hidden] failed. Continue it with cloving_continue, or dismiss it with cloving_dismiss.",
  );
});

await test("CLV-338 channel content masks a private text of more than one line before it takes the first line", () => {
  const message = channelMessage(
    decisionAlert(
      { runId: "run-plan000000", workflowId: "develop" },
      {
        decisionId: "run-plan000000/g",
        type: "choice",
        prompt: "Customer Secret\nInternal Plan is ready. Ship it?",
      },
    ),
    ["Customer Secret\nInternal Plan"],
  );
  assert.equal(
    message.content,
    "Run run-plan… waits for your decision: [hidden] is ready. Ship it? Answer with cloving_questions.",
  );
});

await test("CLV-338 channel content of a private question gives only its preview", () => {
  const message = channelMessage(
    decisionAlert(
      { runId: "run-chats0000", workflowId: "analyze-chats", title: "Chats" },
      {
        decisionId: "run-chats0000/question-1",
        type: "question",
        prompt: "Which chat of Dana Example names the plan?",
      },
    ),
    [],
  );
  assert.equal(
    message.content,
    "Run run-chat… (Chats) asks a question: Private analysis question. Run cloving questions to view it. Answer with cloving_questions and cloving_answer.",
  );
  assert.equal(message.content.includes("Dana"), false);
});

await test("CLV-338 channel content cuts a long text at 300 characters and removes control characters", () => {
  const long = `\u001b[31m${"word ".repeat(100)}`;
  const message = channelMessage(
    decisionAlert(
      { runId: "run-long000000", workflowId: "develop" },
      { decisionId: "run-long000000/g", type: "choice", prompt: long },
    ),
    [],
  );
  const shown = "word ".repeat(100).trim();
  assert.equal(
    message.content,
    `Run run-long… waits for your decision: ${Array.from(shown).slice(0, 299).join("")}… Answer with cloving_questions.`,
  );
});

await test("CLV-338 channel content of a stop with no detail ends the state sentence", () => {
  const alert = runAlert({
    runId: "run-paused0000",
    workflowId: "develop",
    state: "paused",
    revision: 2,
    title: "",
    ticketId: `CLV-1 ${token}`,
  });
  assert.ok(alert);
  assert.deepEqual(channelMessage(alert, []), {
    content:
      "Run run-paus… is paused. Resume it with cloving_resume, or drop it with cloving_drop.",
    meta: {
      run_id: "run-paused0000",
      kind: "paused",
      workflow: "develop",
      ticket: "CLV-1 [hidden]",
    },
  });
});
