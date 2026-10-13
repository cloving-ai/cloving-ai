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
  const silent = line({
    type: "assistant",
    message: { content: [{ type: "text", text: " \n" }] },
  });
  for (const other of ["", "not json", line({ type: "system" }), line(5)])
    assert.deepEqual(activityOf(other), []);
  assert.deepEqual(activityOf(silent), []);
});

const said = line({
  type: "assistant",
  message: { content: [{ type: "text", text: "a" }] },
});
const finished = (result: string, cost: number): string =>
  line({ type: "result", result, total_cost_usd: cost });
const working = {
  key: "k1",
  started,
  result: null,
  lines: [said, finished("Done.", 0.5)],
};

await test("CLV-016 the watch model gives a turn its run, its state and its cost from the journal records", () => {
  const activeAt = "2026-10-13T21:27:00.000Z";
  assert.deepEqual(turnOf({ ...working, activeAt }), {
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
    endedAt: null,
    activeAt: "2026-10-13T21:27:00.000Z",
    commits: [],
    files: [],
    uncommitted: [],
    summary: "",
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

await test("CLV-016 the watch model gives a turn at its end its end time, and the commits, the files and the report of the worker result", () => {
  const completed = turnOf({
    key: "k1",
    started,
    lines: [],
    result: {
      outcome: "completed",
      endedAt: "2026-10-13T21:34:39.000Z",
      result: JSON.stringify({
        summary: "I added the check.",
        commits: ["9e69feb Reject a request", 5],
        files: [" src/a.ts | 6 ++++++"],
        uncommitted: [" M notes.txt"],
      }),
    },
  });
  assert.deepEqual(
    [
      completed.endedAt,
      completed.activeAt,
      completed.summary,
      completed.commits,
      completed.files,
      completed.uncommitted,
    ],
    [
      "2026-10-13T21:34:39.000Z",
      null,
      "I added the check.",
      ["9e69feb Reject a request"],
      [" src/a.ts | 6 ++++++"],
      [" M notes.txt"],
    ],
  );
});

await test("CLV-016 the watch model shows a result that repeats the message before it as one short line with the cost", () => {
  const repeated = turnOf({
    ...working,
    lines: [finished("Done.", 0.25), ...working.lines, finished("a", 0.5)],
  });
  assert.deepEqual(repeated.activity, [
    { kind: "result", text: "Done. (cost 0.25 USD)" },
    { kind: "say", text: "a" },
    { kind: "result", text: "Done. (cost 0.50 USD)" },
    { kind: "result", text: "a (cost 0.50 USD)" },
  ]);
  const echoed = turnOf({
    ...working,
    lines: [said, said, finished("a", 0.5)],
  });
  assert.deepEqual(echoed.activity, [
    { kind: "say", text: "a" },
    { kind: "say", text: "a" },
    { kind: "result", text: "Result of the worker (cost 0.50 USD)" },
  ]);
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

function modelOf(runs: readonly unknown[]): ReturnType<typeof watchModel> {
  return watchModel({
    host: "/host",
    client: "cloving",
    updatedAt: "2026-10-13T21:40:00.000Z",
    service: "up",
    runs,
    decisions: [decision],
    turns: [turnOf({ key: "k1", started, result: null, lines: [] })],
  });
}

await test("CLV-016 the watch model gives a run the decision of its review gate and names the review step after it", () => {
  const events = ["gate.opened", "gate.decided"].map((type, index) => ({
    sequence: index + 1,
    recordedAt: `2026-10-13T21:3${String(index)}:00Z`,
    type,
    payload: { decision: "denied" },
  }));
  const [denied] = modelOf([{ ...run("run-3", ""), events }]).runs;
  assert.deepEqual(
    [denied?.decision, denied?.phases[3]?.name, denied?.phases[3]?.state],
    ["denied", "Denied", "failed"],
  );
});

await test("CLV-016 the watch model orders the runs with the newest first and gives each run its decisions, its events and its turns", () => {
  const model = modelOf([
    run("run-1", "2026-10-13T21:26:00Z"),
    run("run-2", "2026-10-13T21:30:00Z"),
  ]);
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
      phases: model.runs[1]?.phases,
      decision: "",
    },
  );
  assert.deepEqual(
    model.runs[1]?.phases.map((phase) => phase.state),
    ["done", "active", "pending", "pending", "pending"],
  );
  assert.deepEqual(
    [model.host, model.service, model.updatedAt],
    ["/host", "up", "2026-10-13T21:40:00.000Z"],
  );
});
