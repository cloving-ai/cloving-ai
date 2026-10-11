import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedDecisions } from "../src/authority/gates.ts";
import {
  answer,
  answerText,
  approval,
  approve,
  commands,
  continuation,
  deadline,
  expire,
  prompt,
  question,
  reasons,
  runAt,
  started,
  subject,
  wait,
} from "./authority-decision-commands.ts";
import { admit } from "./authority-fixture.ts";

await test("CLV-008 an opened gate stores its kind, its subject digest and its allowed decisions", () => {
  const { state } = commands([admit, started, question]);
  assert.deepEqual(state.gates["run-1 design-1"], {
    runId: "run-1",
    gateId: "design-1",
    kind: "question",
    label: 1,
    subject,
    prompt,
    expiresAt: null,
    generation: 1,
    revision: 1,
    wait: "pending",
    outcome: null,
    openedSequence: 3,
  });
  assert.deepEqual(allowedDecisions("question"), ["answered"]);
  assert.deepEqual(allowedDecisions("approval"), ["approved", "denied"]);
  assert.equal(state.runs["run-1"]?.status, "waiting_gate");
});

await test("CLV-008 the authority rejects a decision outside the allowed decision set of its gate", () => {
  const onQuestion = commands([admit, started, question, wait, approve]);
  assert.deepEqual(reasons(onQuestion).at(-1), "decision-not-allowed");
  const onApproval = commands([admit, started, approval, wait, answer]);
  assert.deepEqual(reasons(onApproval).at(-1), "decision-not-allowed");
  const invented = commands([
    admit,
    started,
    approval,
    wait,
    { ...approve, decision: "expired" },
  ]);
  assert.deepEqual(reasons(invented).at(-1), "decision-not-allowed");
  assert.equal(onQuestion.state.sequence, 4);
  assert.equal(onQuestion.state.gates["run-1 design-1"]?.outcome, null);
});

for (const [decision, opening, command] of [
  ["answered", question, answer],
  ["approved", approval, approve],
  ["denied", approval, { ...approve, decision: "denied" }],
] as const)
  await test(`CLV-008 the decision ${decision} is recorded on its gate and admits one continuation`, () => {
    const outcome = commands([admit, started, opening, wait, command]);
    assert.deepEqual(reasons(outcome).at(-1), "accepted");
    const gate = outcome.state.gates["run-1 design-1"];
    assert.deepEqual(gate?.outcome, {
      decision,
      answer: decision === "answered" ? answerText : null,
      sequence: 5,
    });
    assert.equal(gate.revision, 2);
    assert.equal(outcome.state.runs["run-1"]?.status, "running");
    assert.deepEqual(outcome.state.intents, [continuation]);
    assert.equal(outcome.state.details["run-1"]?.generation, 2);
    const last = outcome.results.at(-1);
    assert.deepEqual(last?.kind === "accepted" ? last.intents : [], [
      continuation,
    ]);
  });

await test("CLV-008 an expired gate records the outcome expired, never an approval, and admits one continuation", () => {
  const timed = { ...approval, expiresAt: deadline };
  const early = runAt([
    { command: admit },
    { command: started },
    { command: timed },
    { command: wait },
    { command: expire, at: "2026-10-10T12:59:59.999Z" },
  ]);
  assert.deepEqual(reasons(early).at(-1), "not-expired");
  const expired = runAt([
    { command: admit },
    { command: started },
    { command: timed },
    { command: wait },
    { command: expire, at: deadline },
  ]);
  assert.deepEqual(reasons(expired).at(-1), "accepted");
  assert.deepEqual(expired.state.gates["run-1 design-1"]?.outcome, {
    decision: "expired",
    answer: null,
    sequence: 5,
  });
  assert.deepEqual(expired.state.intents, [continuation]);
  assert.deepEqual(
    reasons(commands([admit, started, approval, wait, expire])).at(-1),
    "not-expired",
  );
});

await test("CLV-008 the authority rejects a decision with a stale expected revision and commits no event", () => {
  const outcome = commands([
    admit,
    started,
    question,
    wait,
    { ...answer, expectedRevision: 2 },
  ]);
  assert.deepEqual(reasons(outcome).at(-1), "stale-revision");
  assert.equal(outcome.state.sequence, 4);
});

await test("CLV-008 the authority rejects a decision whose subject digest differs from the stored gate", () => {
  const outcome = commands([
    admit,
    started,
    question,
    wait,
    { ...answer, subject: `sha256:${"9".repeat(64)}` },
  ]);
  assert.deepEqual(reasons(outcome).at(-1), "subject-mismatch");
  assert.equal(outcome.state.sequence, 4);
});

await test("CLV-008 the authority rejects a decision for a stale continuation identity", () => {
  const second = {
    ...question,
    commandId: "c-7",
    gateId: "design-2",
    expectedRevision: 4,
  };
  const outcome = commands([
    admit,
    started,
    question,
    wait,
    answer,
    second,
    {
      ...answer,
      commandId: "c-8",
      gateId: "design-2",
      generation: 1,
    },
  ]);
  assert.equal(outcome.state.gates["run-1 design-2"]?.generation, 2);
  assert.deepEqual(reasons(outcome).at(-1), "stale-generation");
  assert.deepEqual(
    reasons(
      commands([admit, started, question, wait, { ...answer, generation: 2 }]),
    ).at(-1),
    "stale-generation",
  );
});

await test("CLV-008 an answer and an expiry for the same gate commit exactly one outcome", () => {
  const timed = { ...question, expiresAt: deadline };
  const answeredFirst = runAt([
    { command: admit },
    { command: started },
    { command: timed },
    { command: wait },
    { command: answer },
    { command: expire, at: deadline },
  ]);
  assert.deepEqual(reasons(answeredFirst).slice(-2), [
    "accepted",
    "decision-not-pending",
  ]);
  const expiredFirst = runAt([
    { command: admit },
    { command: started },
    { command: timed },
    { command: wait },
    { command: expire, at: deadline },
    { command: answer, at: deadline },
  ]);
  assert.deepEqual(reasons(expiredFirst).slice(-2), [
    "accepted",
    "decision-not-pending",
  ]);
  const late = runAt([
    { command: admit },
    { command: started },
    { command: timed },
    { command: wait },
    { command: answer, at: deadline },
  ]);
  assert.deepEqual(reasons(late).at(-1), "decision-expired");
  for (const outcome of [answeredFirst, expiredFirst])
    assert.deepEqual(outcome.state.intents, [continuation]);
});

await test("CLV-008 the authority stores an answer that arrives before the wait registration and applies it one time", () => {
  const early = commands([
    admit,
    started,
    question,
    { ...answer, commandId: "c-4" },
  ]);
  assert.deepEqual(reasons(early).at(-1), "accepted");
  assert.deepEqual(early.state.intents, []);
  assert.equal(early.state.details["run-1"]?.generation, 1);
  const registered = commands([
    admit,
    started,
    question,
    { ...answer, commandId: "c-4" },
    { ...wait, commandId: "c-5" },
    { ...wait, commandId: "c-6" },
  ]);
  assert.deepEqual(reasons(registered).slice(-2), [
    "accepted",
    "wait-already-registered",
  ]);
  assert.deepEqual(registered.state.intents, [
    {
      ...continuation,
      operationId:
        '["cloving-operation",4,"run-1","gate","continue-run",null,"design-1"]',
    },
  ]);
  assert.equal(registered.state.details["run-1"]?.generation, 2);
  assert.equal(registered.state.runs["run-1"]?.revision, 4);
});

await test("CLV-008 a decision on one gate does not make a prepared decision on a second gate stale", () => {
  const second = {
    ...question,
    commandId: "c-7",
    gateId: "design-2",
    expectedRevision: 3,
  };
  const outcome = commands([
    admit,
    started,
    question,
    second,
    wait,
    { ...wait, commandId: "c-8", gateId: "design-2" },
    answer,
    { ...answer, commandId: "c-9", gateId: "design-2" },
  ]);
  assert.deepEqual(reasons(outcome).slice(-2), ["accepted", "accepted"]);
  assert.equal(outcome.state.gates["run-1 design-2"]?.label, 2);
  assert.equal(outcome.state.intents.length, 2);
  assert.equal(outcome.state.runs["run-1"]?.status, "running");
});
