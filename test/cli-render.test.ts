import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeCommand } from "../src/cli/commands.ts";
import {
  decisionList,
  eventText,
  errorText,
  pendingSummary,
  rendered,
} from "../src/cli/render.ts";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";

const receipt = {
  commandId: "c-1",
  sequence: 7,
  runId: "run-1",
  recordedAt: "2026-10-10T12:00:00.000Z",
  commandDigest: "sha256:aa",
};

const run = {
  runId: "run-1",
  workflowId: "develop",
  state: "running",
  condition: "quota-wait",
  revision: 4,
  latestSequence: 9,
  pendingDecisions: [],
  reason: { code: "provider-quota", detail: "A worker reported this reason." },
  evidence: ["event:7", "usage-report-1"],
  lastConfirmedObservation: {
    at: "2026-10-10T12:00:00.000Z",
    sequence: 7,
    source: "worker",
  },
  recovery: { attempts: 1, limit: 3 },
  nextAction: "recheck-eligibility",
  nextActionAt: "2026-10-10T13:00:00.000Z",
  humanInputCanHelp: false,
};

const question = {
  decisionId: "run-1/design-1",
  label: "Q1",
  type: "question",
  prompt: "Which parser?",
  allowed: ["answer"],
  revision: 1,
  generation: 1,
  subjectDigest: "sha256:bb",
};

await test("CLV-008 the human form of each result has its fixed lines", () => {
  assert.equal(
    rendered({
      kind: "run-admitted",
      runId: "run-1",
      commandId: "c-1",
      replayed: true,
      receipt,
    }),
    "Run run-1 is admitted.\nCommand ID: c-1\nReceipt: sequence 7, recorded at 2026-10-10T12:00:00.000Z\nThis is the receipt of the earlier equal command.\nThe run is queued. Admission is not completed work.\n",
  );
  assert.equal(
    rendered({ kind: "run-status", run }),
    [
      "Run run-1 (develop)",
      "State: running",
      "Condition: quota-wait",
      "Reason: provider-quota: A worker reported this reason.",
      "Revision: 4, latest sequence 9",
      "Pending decisions: none",
      "Evidence: event:7, usage-report-1",
      "Last confirmed observation: 2026-10-10T12:00:00.000Z (sequence 7, worker)",
      "Recovery: 1 of 3",
      "Next action: recheck-eligibility at 2026-10-10T13:00:00.000Z",
      "Human input can help: no",
      "",
    ].join("\n"),
  );
  assert.match(
    rendered({
      kind: "run-status",
      run: {
        ...run,
        lastConfirmedObservation: null,
        recovery: { attempts: 0, limit: null },
        nextAction: null,
        nextActionAt: null,
        humanInputCanHelp: true,
        pendingDecisions: ["run-1/design-1"],
      },
    }),
    /Pending decisions: run-1\/design-1\n.*\nLast confirmed observation: none\nRecovery: 0 of no limit\nNext action: none\nHuman input can help: yes\n$/s,
  );
});

await test("CLV-008 the human form of a run list, a run command and a decision has its fixed lines", () => {
  assert.equal(rendered({ kind: "run-list", runs: [] }), "Runs:\n  none\n");
  assert.equal(
    rendered({ kind: "run-list", runs: [run] }),
    "Runs:\n  run-1  develop  quota-wait  revision 4\n",
  );
  assert.equal(
    rendered({
      kind: "run-command",
      command: "drop",
      runId: "run-1",
      commandId: "c-1",
      replayed: false,
      receipt,
      committed: { state: "cancelled", revision: 5, revokedIntents: 1 },
      observed: { condition: "cancelling", unresolvedEffects: ["op-1"] },
    }),
    "Run run-1: drop is committed. State cancelled, revision 5.\nCommand ID: c-1\nReceipt: sequence 7, recorded at 2026-10-10T12:00:00.000Z\nRevoked intents: 1\nObserved: cancelling\nUnresolved effects: op-1\n",
  );
  assert.equal(
    rendered({
      kind: "decision-recorded",
      decisionId: "run-1/design-1",
      decision: "answered",
      commandId: "c-1",
      replayed: false,
      receipt,
      run: { state: "running", revision: 4 },
      continuation: "held",
    }),
    "Decision run-1/design-1 is recorded as answered.\nCommand ID: c-1\nReceipt: sequence 7, recorded at 2026-10-10T12:00:00.000Z\nRun state: running, revision 4\nContinuation: held\n",
  );
  assert.equal(rendered({ kind: "unknown" }), "");
});

await test("CLV-008 the human form of the decisions gives the complete command line for each allowed command", () => {
  assert.deepEqual(decisionList({ decisions: [] }), ["No decision waits."]);
  assert.deepEqual(decisionList({ decisions: [question] }), [
    "Q1 question run-1/design-1",
    "  Prompt: Which parser?",
    "  cloving answer Q1 --text <answer> --expected-revision 1 --generation 1 --subject-digest sha256:bb",
  ]);
  assert.equal(
    rendered({
      kind: "decision-list",
      decisions: [
        {
          ...question,
          label: null,
          type: "approval",
          allowed: ["approve", "deny"],
        },
      ],
    }),
    'approval run-1/design-1\n  Prompt: Which parser?\n  cloving approve run-1/design-1 --expected-revision 1 --generation 1 --subject-digest sha256:bb\n  cloving deny run-1/design-1 --text "<feedback>" --expected-revision 1 --generation 1 --subject-digest sha256:bb\n',
  );
  assert.equal(
    pendingSummary({
      decisions: [question, { ...question, label: null, type: "approval" }],
    }),
    "Pending decisions:\n  Q1 run-1/design-1: Which parser?\n  approval run-1/design-1: Which parser?\n",
  );
  assert.equal(
    pendingSummary({ decisions: [] }),
    "Pending decisions:\n  none\n",
  );
});

await test("CLV-008 the human form of an event is one line", () => {
  const event = {
    sequence: 3,
    recordedAt: "2026-10-10T12:00:00.000Z",
    type: "gate.opened",
    runId: "run-1",
    payload: { gateId: "design-1" },
  };
  assert.equal(
    eventText(event),
    '3  2026-10-10T12:00:00.000Z  gate.opened  run-1  {"gateId":"design-1"}',
  );
  assert.equal(
    rendered({ kind: "event-page", events: [event, "not an event"] }),
    `${eventText(event)}\nundefined  undefined  undefined  undefined  undefined\n`,
  );
});

await test("CLV-008 the runtime directory comes from the environment in a fixed order, and no default path is in a test directory", () => {
  assert.equal(
    runtimeDirectory({
      CLOVING_RUNTIME_DIR: "/a",
      XDG_RUNTIME_DIR: "/b",
      XDG_STATE_HOME: "/c",
    }),
    "/a",
  );
  assert.equal(
    runtimeDirectory({ CLOVING_RUNTIME_DIR: "", XDG_RUNTIME_DIR: "/b" }),
    "/b/cloving",
  );
  assert.equal(runtimeDirectory({ XDG_STATE_HOME: "/c" }), "/c/cloving/run");
  assert.equal(
    runtimeDirectory({ HOME: "/home/operator" }),
    "/home/operator/.local/state/cloving/run",
  );
  assert.equal(runtimeDirectory({ HOME: "" }), undefined);
  assert.equal(runtimeDirectory({}), undefined);
});

await test("CLV-008 a runtime command with no known runtime directory fails with an actionable error, and a command help needs no directory", async () => {
  const output: string[] = [];
  const environment = {
    runtimeDirectory: undefined,
    workingDirectory: ".",
    terminal: {
      out: (text: string) => output.push(`out ${text}`),
      error: (text: string) => output.push(`error ${text}`),
    },
    identifier: () => "c-1",
    interrupted: (): Promise<void> => new Promise(() => undefined),
  };
  assert.equal(
    await runtimeCommand(
      { kind: "questions", runId: null, json: false },
      environment,
    ),
    1,
  );
  assert.equal(
    await runtimeCommand(
      { kind: "command-help", command: "status" },
      environment,
    ),
    0,
  );
  assert.deepEqual(
    output.map((line) => line.split("\n")[0]),
    [
      "error runtime-directory-unknown: No runtime directory is known. Set CLOVING_RUNTIME_DIR to the runtime directory of the service.",
      "out Usage: cloving status [<run-id>] [--limit <n>] [--after <cursor>] [--json]",
    ],
  );
});

await test("CLV-008 the human form gives a prompt a label, shows its control and format characters as visible text and indents each line", () => {
  const text = rendered({
    kind: "decision-list",
    decisions: [
      {
        ...question,
        prompt:
          "cloving approve run-b/deploy --expected-revision 1\nsecond\u001b[2J\r\tend\u007f\u0085\u202e\u2028\u2066x",
      },
    ],
  });
  for (const character of [
    "\u001b",
    "\r",
    "\u007f",
    "\u0085",
    "\u202e",
    "\u2028",
    "\u2066",
  ])
    assert.equal(text.includes(character), false, JSON.stringify(character));
  assert.match(
    text,
    /^ {2}Prompt: cloving approve run-b\/deploy --expected-revision 1\n {4}second\\u001b\[2J\\u000d\\u0009end\\u007f\\u0085\\u202e\\u2028\\u2066x$/m,
  );
  assert.equal(/^ {0,2}cloving approve run-b/m.test(text), false);
  const summary = pendingSummary({
    decisions: [{ ...question, prompt: "first\nsecond\u0007" }],
  });
  assert.match(summary, /: first\n {4}second\\u0007\n$/);
});

await test("CLV-008 the human form of an error shows control characters as visible text and lists the candidates of an ambiguous reference", () => {
  assert.equal(
    errorText({
      code: "ticket\u001b[2J-closed",
      detail: "The ticket is closed.\ncloving drop run-1\u202e",
    }),
    "ticket\\u001b[2J-closed: The ticket is closed.\n    cloving drop run-1\\u202e\n",
  );
  assert.equal(
    errorText({
      code: "ambiguous-decision",
      detail: "The reference matches more than one pending decision.",
      candidates: ["run-1/design-1", "run-1/design-2"],
    }),
    "ambiguous-decision: The reference matches more than one pending decision.\nCandidates: run-1/design-1, run-1/design-2\n",
  );
});

await test("CLV-008 the human form shows zero-width and direction format characters as visible text, also in the candidates of an error", () => {
  const text = rendered({
    kind: "decision-list",
    decisions: [{ ...question, prompt: "a\u061c\u200b\u200f\ufeffb" }],
  });
  assert.match(text, /^ {2}Prompt: a\\u061c\\u200b\\u200f\\ufeffb$/m);
  assert.equal(
    errorText({
      code: "ambiguous-decision",
      detail: "More than one decision.",
      candidates: ["run-1/design-1\u001b[2J", "run-1/\u202edesign-2"],
    }),
    "ambiguous-decision: More than one decision.\nCandidates: run-1/design-1\\u001b[2J, run-1/\\u202edesign-2\n",
  );
});

await test("CLV-008 a result with a kind that the CLI does not know gives no text and no fault", () => {
  for (const kind of ["constructor", "toString", "valueOf", "later-kind"])
    assert.equal(rendered({ kind }), "", kind);
});
