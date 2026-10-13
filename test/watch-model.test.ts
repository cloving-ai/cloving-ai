import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityOf,
  decisionCommands,
  turnOf,
  watchModel,
} from "../src/cli/watch-model.ts";

const line = (value: unknown): string => JSON.stringify(value);
const operationId =
  '["cloving-operation",1,"run-1","implement","claude-turn",null,null]';
const started = {
  operationId,
  target: "clv-016-a6f7ef47",
  branch: "cloving/clv-016-a6f7ef47",
  worktree: "/host/worktrees/clv-016-a6f7ef47",
  startedAt: "2026-10-13T21:26:01.000Z",
};

await test("CLV-016 the watch model reads the stream of a Claude turn as short activity items", () => {
  const assistant = line({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I read the port." },
        { type: "tool_use", name: "Bash", input: { command: "git status" } },
        { type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } },
        { type: "tool_use", name: "Grep", input: { pattern: "isObject" } },
        { type: "tool_use", name: "Task", input: { other: 1 } },
      ],
    },
  });
  assert.deepEqual(activityOf(assistant), [
    { kind: "say", text: "I read the port." },
    { kind: "tool", text: "Bash: git status" },
    { kind: "tool", text: "Read: /a/b.ts" },
    { kind: "tool", text: "Grep: isObject" },
    { kind: "tool", text: 'Task: {"other":1}' },
  ]);
  const failed = line({
    type: "user",
    message: {
      content: [
        { type: "tool_result", is_error: true, content: "exit code 1" },
        { type: "tool_result", content: "a long output" },
      ],
    },
  });
  assert.deepEqual(activityOf(failed), [
    { kind: "error", text: "exit code 1" },
  ]);
  const result = line({
    type: "result",
    result: "Done.",
    total_cost_usd: 1.0330776000000002,
  });
  assert.deepEqual(activityOf(result), [
    { kind: "result", text: "Done. (cost 1.03 USD)" },
  ]);
  const long = line({
    type: "assistant",
    message: { content: [{ type: "text", text: "x".repeat(900) }] },
  });
  assert.equal(activityOf(long)[0]?.text.length, 601);
  for (const other of ["", "not json", line({ type: "system" }), line(5)])
    assert.deepEqual(activityOf(other), []);
});

await test("CLV-016 the watch model gives a turn its run, its state and its cost from the journal records", () => {
  const lines = [
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: "a" }] },
    }),
    line({ type: "result", result: "Done.", total_cost_usd: 0.5 }),
  ];
  assert.deepEqual(turnOf({ key: "k1", started, result: null, lines }), {
    key: "k1",
    runId: "run-1",
    target: "clv-016-a6f7ef47",
    branch: "cloving/clv-016-a6f7ef47",
    worktree: "/host/worktrees/clv-016-a6f7ef47",
    startedAt: "2026-10-13T21:26:01.000Z",
    outcome: "in work",
    costUsd: 0.5,
    activity: [
      { kind: "say", text: "a" },
      { kind: "result", text: "Done. (cost 0.50 USD)" },
    ],
  });
  const ended = turnOf({
    key: "k1",
    started: { operationId: "not a list" },
    result: { outcome: "failed" },
    lines: [],
  });
  assert.deepEqual(
    [ended.runId, ended.outcome, ended.costUsd, ended.target],
    ["", "failed", null, ""],
  );
});

const decision = {
  decisionId: "run-1/review-1",
  type: "approval",
  runId: "run-1",
  prompt: "Review the work.",
  revision: 1,
  generation: 2,
  subjectDigest: "sha256:abc",
};

await test("CLV-016 the watch model gives each pending decision its approve and deny commands", () => {
  assert.deepEqual(decisionCommands(decision, "cloving"), {
    decisionId: "run-1/review-1",
    type: "approval",
    prompt: "Review the work.",
    approve:
      "cloving approve run-1/review-1 --expected-revision 1 --generation 2 --subject-digest sha256:abc",
    deny: "cloving deny run-1/review-1 --expected-revision 1 --generation 2 --subject-digest sha256:abc",
  });
});

function run(runId: string, at: string): Record<string, unknown> {
  return {
    status: {
      runId,
      workflowId: "develop-ticket",
      state: "waiting_gate",
      reason: { code: "policy-approval", detail: "A person must approve." },
      budget: { limit: 8, spent: 1 },
    },
    events: [{ sequence: 1, recordedAt: at, type: "run.created", payload: {} }],
  };
}

await test("CLV-016 the watch model orders the runs with the newest first and gives each run its decisions, its events and its turns", () => {
  const model = watchModel({
    host: "/host",
    client: "cloving",
    updatedAt: "2026-10-13T21:40:00.000Z",
    service: "up",
    runs: [
      run("run-1", "2026-10-13T21:26:00Z"),
      run("run-2", "2026-10-13T21:30:00Z"),
    ],
    decisions: [decision],
    turns: [turnOf({ key: "k1", started, result: null, lines: [] })],
  });
  assert.deepEqual(
    model.runs.map((item) => [
      item.runId,
      item.decisions.length,
      item.turns.length,
    ]),
    [
      ["run-2", 0, 0],
      ["run-1", 1, 1],
    ],
  );
  assert.deepEqual(
    { ...model.runs[1], decisions: [], turns: [] },
    {
      runId: "run-1",
      workflowId: "develop-ticket",
      state: "waiting_gate",
      code: "policy-approval",
      detail: "A person must approve.",
      spent: 1,
      limit: 8,
      decisions: [],
      events: [
        {
          sequence: 1,
          recordedAt: "2026-10-13T21:26:00Z",
          type: "run.created",
        },
      ],
      turns: [],
    },
  );
  assert.deepEqual(
    [model.host, model.service, model.updatedAt],
    ["/host", "up", "2026-10-13T21:40:00.000Z"],
  );
});
