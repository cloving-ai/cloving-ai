import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvent } from "../src/authority/events.ts";
import { rebuild } from "../src/authority/reducer.ts";
import {
  answer,
  answerText,
  approve,
  commands,
  deadline,
  expire,
  noon,
  prompt,
  question,
  reasons,
  runAt,
  started,
  subject,
  wait,
  type Command,
} from "./authority-decision-commands.ts";
import { admit } from "./authority-fixture.ts";

await test("CLV-161 a conditional observation cannot replace a newer report and a matching restoration replays", () => {
  const missing = {
    kind: "report-observation",
    commandId: "missing",
    runId: "run-1",
    condition: "infrastructure-failure",
    reason: "pinned-workflow-unavailable",
  };
  const restored = {
    ...missing,
    commandId: "restored",
    condition: "working",
    reason: "in-progress",
    expectedObservation: 3,
  };
  const newer = {
    ...missing,
    commandId: "quota",
    condition: "quota-wait",
    reason: "provider-quota",
  };
  const stale = commands([admit, started, missing, newer, restored]);
  assert.equal(reasons(stale).at(-1), "stale-observation");
  assert.equal(
    stale.state.details["run-1"]?.observation?.reason,
    "provider-quota",
  );
  const matched = commands([admit, started, missing, restored]);
  assert.equal(reasons(matched).at(-1), "accepted");
  assert.equal(
    matched.state.details["run-1"]?.observation?.reason,
    "in-progress",
  );
  assert.deepEqual(
    rebuild(
      matched.results.flatMap((result) =>
        result.kind === "accepted" ? result.events : [],
      ),
    ),
    matched.state,
  );
  const initial = commands([admit, { ...missing, expectedObservation: 0 }]);
  assert.equal(reasons(initial).at(-1), "accepted");
  for (const expectedObservation of [-1, 1.5, "3"]) {
    assert.equal(
      reasons(commands([admit, { ...missing, expectedObservation }])).at(-1),
      "invalid-command",
    );
  }
});

await test("CLV-008 a dropped run cancels its open gates and admits no continuation for them", () => {
  const outcome = commands([
    admit,
    started,
    question,
    wait,
    {
      kind: "cancel-run",
      commandId: "c-5",
      runId: "run-1",
      expectedRevision: 3,
    },
    { ...answer, commandId: "c-6" },
    { ...wait, commandId: "c-7" },
  ]);
  assert.deepEqual(reasons(outcome).slice(-3), [
    "accepted",
    "decision-not-pending",
    "terminal-run",
  ]);
  assert.deepEqual(outcome.state.gates["run-1 design-1"]?.outcome, {
    decision: null,
    answer: null,
    sequence: 5,
  });
  assert.deepEqual(outcome.state.intents, []);
});

await test("CLV-008 a reported observation is stored for its run and changes no status and no revision", () => {
  const observation = {
    kind: "report-observation",
    commandId: "c-3",
    runId: "run-1",
    condition: "quota-wait",
    reason: "provider-quota",
    evidence: "usage-report-1",
    retryAt: deadline,
    attempt: 1,
    limit: 3,
  };
  const outcome = commands([admit, started, observation]);
  assert.deepEqual(reasons(outcome).at(-1), "accepted");
  assert.deepEqual(outcome.state.details["run-1"]?.observation, {
    condition: "quota-wait",
    reason: "provider-quota",
    evidence: "usage-report-1",
    retryAt: deadline,
    operationId: null,
    attempt: 1,
    limit: 3,
    sequence: 3,
    recordedAt: noon,
  });
  assert.deepEqual(outcome.state.runs["run-1"], {
    runId: "run-1",
    status: "running",
    revision: 2,
    workflow: "pin-1",
    pausedFrom: null,
    gates: [],
  });
  const afterEnd = commands([
    admit,
    {
      kind: "cancel-run",
      commandId: "c-2",
      runId: "run-1",
      expectedRevision: 1,
    },
    { ...observation, condition: "stopped", reason: "worker-exit" },
  ]);
  assert.deepEqual(reasons(afterEnd).at(-1), "accepted");
  assert.deepEqual(reasons(commands([{ ...observation, runId: "run-9" }])), [
    "unknown-run",
  ]);
});

await test("CLV-008 an admitted run stores its submission, its execution input and its resolver identity", () => {
  const bound = {
    ...admit,
    submission: `sha256:${"4".repeat(64)}`,
    input: `sha256:${"5".repeat(64)}`,
    resolver: "fake-resolver:1",
  };
  const outcome = commands([bound]);
  assert.deepEqual(outcome.state.details["run-1"], {
    runId: "run-1",
    generation: 1,
    submission: bound.submission,
    input: bound.input,
    resolver: "fake-resolver:1",
    observation: null,
  });
  assert.deepEqual(commands([admit]).state.details["run-1"], {
    runId: "run-1",
    generation: 1,
    submission: null,
    input: null,
    resolver: null,
    observation: null,
  });
});

await test("CLV-008 a command with an incomplete field group or a wrong field form is invalid", () => {
  const invalid: readonly Command[] = [
    { ...admit, submission: `sha256:${"4".repeat(64)}` },
    { ...question, subject: undefined },
    { ...question, gateKind: "vote" },
    { ...question, gateKind: undefined, expiresAt: deadline },
    { ...question, expiresAt: "tomorrow" },
    { ...question, expiresAt: "2026-13-45T99:99:99Z" },
    { ...question, expiresAt: "2026-02-30T00:00:00Z" },
    { ...question, expiresAt: "2026-10-10T24:00:00Z" },
    { ...question, expiresAt: "2025-02-29T00:00:00.000Z" },
    { ...question, expiresAt: "2026-04-31T00:00:00Z" },
    { ...question, expiresAt: "2026-00-10T00:00:00Z" },
    { ...question, expiresAt: "2026-10-00T00:00:00Z" },
    { ...question, expiresAt: "2026-10-10T00:60:00Z" },
    { ...question, expiresAt: "2026-10-10T00:00:60Z" },
    { ...question, expiresAt: 20261010 },
    { ...answer, generation: undefined },
    { ...answer, answer: undefined },
    { ...approve, answer: answerText },
    { ...answer, generation: 0 },
    { ...expire, expectedRevision: 1 },
    {
      kind: "report-observation",
      commandId: "c-3",
      runId: "run-1",
      condition: "sleeping",
      reason: "unknown",
    },
    {
      kind: "report-observation",
      commandId: "c-3",
      runId: "run-1",
      condition: "working",
      reason: "progress",
      attempt: 1,
    },
  ];
  for (const command of invalid)
    assert.deepEqual(
      reasons(commands([admit, started, command])).at(-1),
      "invalid-command",
      JSON.stringify(command),
    );
});

await test("CLV-008 a command or an event whose run ID or command ID is the name of an inherited object property is invalid", () => {
  const event = {
    sequence: 1,
    type: "run.created",
    runId: "run-1",
    commandId: "c-1",
    recordedAt: noon,
    request: "{}",
    payload: {},
  };
  assert.notEqual(parseEvent(event), null);
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const outcome = commands([
      { ...admit, runId: name },
      { ...admit, commandId: name },
      {
        kind: "report-observation",
        commandId: "c-9",
        runId: name,
        condition: "working",
        reason: "progress",
      },
    ]);
    assert.deepEqual(reasons(outcome), Array(3).fill("invalid-command"), name);
    assert.equal(outcome.state.sequence, 0);
    assert.equal(parseEvent({ ...event, runId: name }), null);
    assert.equal(parseEvent({ ...event, commandId: name }), null);
  }
});

await test("CLV-008 the full question and the full answer references survive a rebuild from the events", () => {
  const outcome = commands([admit, started, question, wait, answer]);
  const events = outcome.results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.deepEqual(rebuild(events), outcome.state);
  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [
      ["run.created", { workflow: "pin-1" }],
      ["run.started", {}],
      [
        "gate.opened",
        { gateId: "design-1", gateKind: "question", subject, prompt },
      ],
      ["gate.wait-registered", { gateId: "design-1" }],
      [
        "gate.decided",
        {
          gateId: "design-1",
          decision: "answered",
          generation: "1",
          subject,
          answer: answerText,
        },
      ],
    ],
  );
});

await test("CLV-008 an untyped gate keeps its accepted behavior", () => {
  const outcome = commands([
    admit,
    started,
    { ...question, gateKind: undefined, subject: undefined, prompt: undefined },
    {
      kind: "decide-gate",
      commandId: "c-4",
      runId: "run-1",
      gateId: "design-1",
      decision: "approved",
      expectedRevision: 3,
    },
  ]);
  assert.deepEqual(reasons(outcome).at(-1), "accepted");
  assert.equal(outcome.state.gates["run-1 design-1"]?.kind, "untyped");
  assert.equal(outcome.state.gates["run-1 design-1"].wait, "registered");
  assert.equal(outcome.state.intents.length, 1);
});

await test("CLV-008 an expiry compares a deadline and a command time with and without milliseconds", () => {
  const timed = { ...question, gateKind: "approval", expiresAt: deadline };
  const short = "2026-10-10T13:00:00Z";
  const outcome = runAt([
    { command: admit },
    { command: started },
    { command: timed },
    { command: wait },
    { command: expire, at: "2026-10-10T12:59:59Z" },
    { command: { ...expire, commandId: "c-7" }, at: short },
  ]);
  assert.deepEqual(reasons(outcome).slice(4), ["not-expired", "accepted"]);
});

await test("CLV-008 a deadline on a day that exists is valid, also on a leap day", () => {
  for (const expiresAt of [
    "2024-02-29T23:59:59.000Z",
    "2026-12-31T00:00:00Z",
    "2026-04-30T23:59:59Z",
    "2000-02-29T12:00:00.000Z",
  ])
    assert.deepEqual(
      reasons(commands([admit, started, { ...question, expiresAt }])).at(-1),
      "accepted",
      expiresAt,
    );
  assert.deepEqual(
    reasons(
      commands([
        admit,
        started,
        { ...question, expiresAt: "2100-02-29T00:00:00Z" },
      ]),
    ).at(-1),
    "invalid-command",
  );
});

await test("CLV-062 a denial carries a feedback document that survives a rebuild from the events, and an approval with a feedback document is invalid", () => {
  const denial = { ...approve, decision: "denied", answer: answerText };
  const outcome = commands([
    admit,
    started,
    { ...question, gateKind: "approval" },
    wait,
    denial,
  ]);
  assert.deepEqual(reasons(outcome).at(-1), "accepted");
  assert.deepEqual(outcome.state.gates["run-1 design-1"]?.outcome, {
    decision: "denied",
    answer: answerText,
    sequence: 5,
  });
  const events = outcome.results.flatMap((result) =>
    result.kind === "accepted" ? result.events : [],
  );
  assert.deepEqual(rebuild(events), outcome.state);
  assert.deepEqual(
    events.map((event) => parseEvent(JSON.parse(JSON.stringify(event)))).at(-1)
      ?.payload,
    {
      gateId: "design-1",
      decision: "denied",
      generation: "1",
      subject,
      answer: answerText,
    },
  );
  assert.deepEqual(
    reasons(
      commands([
        admit,
        started,
        { ...question, gateKind: "approval" },
        wait,
        { ...denial, decision: "approved" },
      ]),
    ).at(-1),
    "invalid-command",
  );
});
