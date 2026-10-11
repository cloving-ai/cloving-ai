import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuild } from "../src/authority/reducer.ts";
import {
  answer,
  answerText,
  approval,
  commands,
  deadline,
  expire,
  question,
  reasons,
  runAt,
  started,
  wait,
} from "./authority-decision-commands.ts";
import { admit } from "./authority-fixture.ts";

await test("CLV-008 a decision, an expiry or a wait registration for an unknown gate is rejected", () => {
  for (const command of [
    { ...answer, commandId: "c-3", expectedRevision: 2 },
    { ...expire, commandId: "c-3" },
    { ...wait, commandId: "c-3" },
  ])
    assert.deepEqual(
      reasons(commands([admit, started, command])).at(-1),
      "unknown-gate",
      command.kind,
    );
});

await test("CLV-008 an expiry of a gate with an outcome is rejected as not pending, and an expiry of an untyped gate as not expired", () => {
  assert.deepEqual(
    reasons(commands([admit, started, question, wait, answer, expire])).at(-1),
    "decision-not-pending",
  );
  const untyped = {
    kind: "open-gate",
    commandId: "c-3",
    runId: "run-1",
    gateId: "design-1",
    expectedRevision: 2,
  };
  assert.deepEqual(
    reasons(commands([admit, started, untyped, expire])).at(-1),
    "not-expired",
  );
  assert.deepEqual(
    reasons(
      commands([
        admit,
        started,
        untyped,
        { ...answer, commandId: "c-4", expectedRevision: 3 },
      ]),
    ).at(-1),
    "decision-not-allowed",
  );
});

await test("CLV-008 a rebuild refuses a second event of one command and an event for an unknown run", () => {
  const outcome = commands([admit, started]);
  const events = outcome.results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  const [first, second] = events;
  assert.ok(first && second);
  assert.throws(
    () =>
      rebuild([
        first,
        {
          ...second,
          commandId: first.commandId,
          request: second.request.replace("c-2", first.commandId),
        },
      ]),
    /invalid-event: 2 duplicate-command/,
  );
  assert.throws(
    () => rebuild([{ ...second, sequence: 1 }]),
    /invalid-event: 1 unknown-run/,
  );
});

await test("CLV-008 a decision on a paused run and a decision on a failed run are rejected", () => {
  const paused = commands([
    admit,
    started,
    question,
    wait,
    {
      kind: "pause-run",
      commandId: "c-5",
      runId: "run-1",
      expectedRevision: 3,
    },
    { ...answer, commandId: "c-6" },
  ]);
  assert.deepEqual(reasons(paused).at(-1), "invalid-transition");
  const failed = commands([
    admit,
    started,
    question,
    wait,
    {
      kind: "fail-run",
      commandId: "c-5",
      runId: "run-1",
      expectedRevision: 3,
    },
    { ...answer, commandId: "c-6" },
  ]);
  assert.deepEqual(reasons(failed).at(-1), "decision-not-pending");
  assert.deepEqual(failed.state.gates["run-1 design-1"]?.outcome, {
    decision: null,
    answer: null,
    sequence: 5,
  });
});

const untyped = {
  kind: "open-gate",
  commandId: "c-3",
  runId: "run-1",
  gateId: "design-1",
  expectedRevision: 2,
};
const untypedDecision = {
  kind: "decide-gate",
  commandId: "c-4",
  runId: "run-1",
  gateId: "design-1",
  decision: "approved",
  expectedRevision: 3,
};

await test("CLV-008 a second opening of a typed gate identity is rejected, and an early answer keeps its record and its continuation", () => {
  const outcome = commands([
    admit,
    started,
    question,
    answer,
    { ...question, commandId: "c-7", expectedRevision: 4 },
    wait,
  ]);
  assert.deepEqual(reasons(outcome).slice(3), [
    "accepted",
    "existing-gate",
    "accepted",
  ]);
  const gate = outcome.state.gates["run-1 design-1"];
  assert.deepEqual(gate?.outcome, {
    decision: "answered",
    answer: answerText,
    sequence: 4,
  });
  assert.deepEqual(
    [gate.label, gate.generation, gate.wait],
    [1, 1, "registered"],
  );
  assert.equal(outcome.state.questions, 1);
  assert.deepEqual(
    outcome.state.intents.map((intent) => intent.kind),
    ["continue-run"],
  );
});

await test("CLV-008 a gate identity with a record is not opened again with a different kind, and a later question gets the next label", () => {
  const other = {
    ...question,
    commandId: "c-8",
    gateId: "design-2",
    expectedRevision: 4,
  };
  const afterAnswer = commands([
    admit,
    started,
    question,
    wait,
    answer,
    { ...approval, commandId: "c-7", expectedRevision: 4 },
    { ...untyped, commandId: "c-9", expectedRevision: 4 },
    other,
  ]);
  assert.deepEqual(reasons(afterAnswer).slice(5), [
    "existing-gate",
    "existing-gate",
    "accepted",
  ]);
  assert.equal(afterAnswer.state.gates["run-1 design-1"]?.kind, "question");
  assert.equal(afterAnswer.state.gates["run-1 design-2"]?.label, 2);
  assert.equal(afterAnswer.state.questions, 2);
  const afterUntyped = commands([
    admit,
    started,
    untyped,
    untypedDecision,
    { ...question, commandId: "c-7", expectedRevision: 4 },
  ]);
  assert.deepEqual(reasons(afterUntyped).at(-1), "existing-gate");
  assert.equal(afterUntyped.state.gates["run-1 design-1"]?.kind, "untyped");
});

await test("CLV-008 an expired gate identity is not opened again", () => {
  const expired = runAt([
    { command: admit },
    { command: started },
    { command: { ...approval, expiresAt: deadline } },
    { command: wait },
    { command: expire, at: deadline },
    {
      command: {
        ...approval,
        commandId: "c-7",
        expectedRevision: 4,
        expiresAt: "2026-10-10T14:00:00.000Z",
      },
      at: deadline,
    },
  ]);
  assert.deepEqual(reasons(expired).slice(4), ["accepted", "existing-gate"]);
  assert.equal(
    expired.state.gates["run-1 design-1"]?.outcome?.decision,
    "expired",
  );
  assert.equal(expired.state.runs["run-1"]?.status, "running");
});

await test("CLV-008 an untyped gate identity keeps its accepted reuse after a decision", () => {
  const reused = commands([
    admit,
    started,
    untyped,
    untypedDecision,
    { ...untyped, commandId: "c-5", expectedRevision: 4 },
    { ...untypedDecision, commandId: "c-6", expectedRevision: 5 },
  ]);
  assert.deepEqual(reasons(reused), Array(6).fill("accepted"));
  assert.equal(reused.state.intents.length, 2);
});

await test("CLV-008 an untyped decision with the text cancelled admits its continuation, and a rebuild of its events gives the same state", () => {
  const outcome = commands([
    admit,
    started,
    untyped,
    { ...untypedDecision, decision: "cancelled" },
  ]);
  assert.deepEqual(reasons(outcome), Array(4).fill("accepted"));
  assert.deepEqual(
    outcome.state.intents.map((intent) => intent.operationId),
    ['["cloving-operation",4,"run-1","gate","continue-run",null,"design-1"]'],
  );
  const events = outcome.results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.deepEqual(rebuild(events), outcome.state);
});
