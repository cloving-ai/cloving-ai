import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decisionAlert,
  runAlert,
  stoppedScheduleAlert,
} from "../src/alert-selection.ts";
import { decisionLines } from "../src/cli/render.ts";
import {
  decisionNotification,
  notifyEvent,
  outcomeNotification,
  stoppedScheduleNotification,
} from "../src/daemon/notify-message.ts";
import { npxProgram } from "./exec-cache-fixture.ts";

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

await test("CLV-242 a stopped schedule message names its three failures and resume command", () => {
  const schedule = {
    workflowId: "review-queue",
    state: "stopped",
    stoppedAt: 900000,
    stoppedSlot: 3,
    failuresInRow: 3,
    failedRunIds: ["run-one", "run-two", "run-three"],
  };
  const event = stoppedScheduleNotification(schedule);
  assert.ok(event);
  assert.equal(event.key, "schedule-stopped:review-queue:3");
  assert.equal(event.message.event, "schedule-stopped");
  assert.equal(event.message.runId, "run-three");
  for (const runId of schedule.failedRunIds)
    assert.ok(event.message.body.includes(runId));
  assert.ok(
    event.message.body.endsWith("cloving schedule resume review-queue"),
  );
  assert.equal(
    stoppedScheduleNotification({ ...schedule, state: "active" }),
    undefined,
  );
});

await test("CLV-090 notification text matches questions, including question commands and feedback", () => {
  const notification = decisionNotification(run, question);
  assert.equal(
    notification.message.body,
    decisionLines(question, "cloving").join("\n"),
  );
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
    decision.message.body.endsWith(
      String(decisionLines(question, "cloving").at(-1)),
    ),
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

await test("CLV-338 a paused run notifies with its reason and status command", () => {
  const pausedRun = {
    runId: "run-paused",
    workflowId: "develop-ticket",
    state: "paused",
    revision: 4,
    reason: { code: "paused", detail: "The operator paused the run." },
  };
  const paused = outcomeNotification(pausedRun);
  assert.ok(paused);
  assert.equal(paused.key, "paused:run-paused:4");
  assert.equal(
    outcomeNotification({ ...pausedRun, revision: 6 })?.key,
    "paused:run-paused:6",
  );
  assert.throws(
    () => outcomeNotification({ ...pausedRun, revision: undefined }),
    /invalid-alert-revision/,
  );
  assert.equal(paused.message.event, "paused");
  assert.equal(paused.message.subject, "Cloving: develop-ticket paused");
  assert.equal(
    paused.message.body,
    "Reason: paused: The operator paused the run.\ncloving status run-paused",
  );
});

await test("CLV-338 a continued or dismissed failed run gives no notification", () => {
  const failed = {
    runId: "run-failed",
    workflowId: "develop-ticket",
    state: "failed",
    reason: { code: "turn-failed", detail: "The turn failed." },
  };
  assert.equal(outcomeNotification(failed)?.key, "failed:run-failed");
  assert.equal(
    outcomeNotification({ ...failed, continuedBy: "run-next" }),
    undefined,
  );
  assert.equal(outcomeNotification({ ...failed, dismissed: true }), undefined);
});

await test("CLV-345 from the exec cache, each command of a notification starts with the npx client program", () => {
  const schedule = stoppedScheduleAlert({
    workflowId: "review-queue",
    state: "stopped",
    stoppedSlot: 3,
    failedRunIds: ["run-one", "run-two", "run-three"],
  });
  assert.ok(schedule);
  assert.ok(
    notifyEvent(schedule, npxProgram).message.body.endsWith(
      `\n${npxProgram} schedule resume review-queue`,
    ),
  );
  const failed = runAlert({
    ...run,
    state: "failed",
    reason: { code: "turn-failed", detail: "The turn failed." },
  });
  assert.ok(failed);
  assert.equal(
    notifyEvent(failed, npxProgram).message.body,
    `Reason: turn-failed: The turn failed.\n${npxProgram} status run-one`,
  );
  assert.ok(
    notifyEvent(decisionAlert(run, question), npxProgram).message.body.includes(
      `\n  ${npxProgram} answer Q1 --text <answer> `,
    ),
  );
});

await test("CLV-345 a decision notification with an allowed name that is not a decision command stays bounded and keeps its command", () => {
  const decision = decisionNotification(run, {
    ...question,
    allowed: ["escalate", "answer"],
    feedback: [{ decisionId: "prior", text: "f".repeat(8000) }],
  });
  assert.equal(decision.message.body.length, 4000);
  assert.ok(
    decision.message.body.endsWith(
      String(decisionLines(question, "cloving").at(-1)),
    ),
  );
});
