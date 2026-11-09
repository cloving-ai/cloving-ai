import assert from "node:assert/strict";
import { test } from "node:test";
import { codexStream } from "../src/daemon/codex-stream.ts";
import {
  assistant,
  entry,
  lines,
  read,
  toolResult,
} from "./turn-transcript-fixture.ts";

const shape = (found: ReturnType<typeof read>) =>
  found.map((item) => [item.kind, item.summary, item.text, item.error]);

await test("CLV-329 system events of a Claude stream give notices with a short text", () => {
  const notices = read(
    lines(
      { type: "system", subtype: "init", model: "claude-opus-5-5" },
      { type: "system", subtype: "task_started", description: "Lint" },
      {
        type: "system",
        subtype: "task_notification",
        status: "completed",
        summary: "Lint",
      },
      {
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        error_status: 529,
        error: "overloaded",
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
      },
      { type: "system", subtype: "compact_boundary" },
      {
        type: "user",
        message: { content: [{ type: "text", text: "Go on." }] },
      },
    ),
  ).map((found) => found.text);
  assert.deepEqual(notices, [
    "Session started · model claude-opus-5-5",
    "Task started: Lint",
    "Task completed: Lint",
    "API retry 2 of 10: 529 overloaded",
    "Rate limit five_hour: rejected",
    "Context compacted",
    "Go on.",
  ]);
});

await test("CLV-329 a line of another harness and a line that is not JSON become notices with their raw text", () => {
  const raw = '{"type":"step_start","part":{"id":"p1"}}';
  assert.deepEqual(read(lines(raw, "plain output of a tool")), [
    entry(1, { kind: "notice", text: raw }),
    entry(2, { kind: "notice", text: "plain output of a tool" }),
  ]);
});

await test("CLV-329 a Codex turn gives the messages, commands, file changes and failed output that the worker keeps in its journal", () => {
  const stream = codexStream();
  const events = [
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "item.completed",
      item: { type: "reasoning", text: "Look at the tests." },
    },
    {
      type: "item.started",
      item: { type: "command_execution", command: "npm test" },
    },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        aggregated_output: "1 failed",
        exit_code: 1,
        status: "failed",
      },
    },
    {
      type: "item.completed",
      item: { type: "file_change", changes: [{ path: "src/a.ts" }] },
    },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "One test fails." },
    },
    { type: "turn.completed", usage: { input_tokens: 10 } },
  ];
  const journal = [
    ...events.flatMap((event) => stream.line(JSON.stringify(event))),
    stream.result(0),
  ];
  assert.deepEqual(shape(read(lines(...journal))), [
    ["notice", "", "Session started", false],
    ["tool-call", "Bash: npm test", '{\n  "command": "npm test"\n}', false],
    ["tool-result", "", "1 failed", true],
    ["tool-call", "Edit: src/a.ts", '{\n  "file_path": "src/a.ts"\n}', false],
    ["assistant", "", "One test fails.", false],
    ["result", "", "Turn end: success · cost unknown · 1 turn", false],
  ]);
});

await test("CLV-329 quiet Claude events give no entry, and unknown parts and system events give raw notices", () => {
  const unknownPart = { type: "image", source: "data" };
  const unknownEvent = { type: "system", subtype: "status", status: "busy" };
  const found = read(
    lines(
      ...[
        "thinking_tokens",
        "task_progress",
        "task_updated",
        "background_tasks_changed",
        "hook_started",
        "vcs_state_changed",
      ].map((subtype) => ({ type: "system", subtype })),
      { type: "command_lifecycle" },
      { type: "stream_event" },
      assistant(
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: " " },
        unknownPart,
      ),
      unknownEvent,
      {
        type: "system",
        subtype: "hook_response",
        hook_name: "Stop",
        outcome: "success",
      },
      { type: "user", message: { content: "The prompt." } },
      toolResult([{ type: "text", text: "line" }, { type: "image" }, {}]),
    ),
  );
  assert.deepEqual(
    found.map((item) => [item.kind, item.text]),
    [
      ["notice", JSON.stringify(unknownPart)],
      ["notice", JSON.stringify(unknownEvent)],
      ["notice", "Hook Stop: success"],
      ["notice", "The prompt."],
      ["tool-result", "line\n[image]\n[content]"],
    ],
  );
});

await test("CLV-329 a failed Claude result gives an error mark and its text, and a result without a cost says that the cost is unknown", () => {
  const found = read(
    lines(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        result: "The model stopped.",
      },
      { type: "result", subtype: "error_max_turns", is_error: true },
    ),
  );
  assert.deepEqual(
    found.map((item) => [item.text, item.error]),
    [
      [
        "Turn end: error_during_execution · cost unknown · 1 turn\nThe model stopped.",
        true,
      ],
      ["Turn end: error_max_turns · cost unknown\nerror", true],
    ],
  );
});

await test("CLV-329 a long tool input gives a summary of one line with at most 200 characters, and a call without input shows an empty object", () => {
  const found = read(
    lines(
      assistant({
        type: "tool_use",
        name: "Bash",
        input: { command: `echo ${"word ".repeat(100)}\nnext` },
      }),
      assistant({ type: "tool_use", name: "TodoWrite", input: { todos: [] } }),
      assistant({ type: "tool_use", name: "Exit" }),
    ),
  );
  const [long, other, empty] = found.map((item) => item.summary);
  assert.equal(long?.length, "Bash: ".length + 200);
  assert.ok(long.endsWith("…"));
  assert.doesNotMatch(long, /\n/);
  assert.equal(other, 'TodoWrite: {"todos":[]}');
  assert.equal(empty, "Exit: {}");
});

await test("CLV-329 a summary masks a token in a command", () => {
  const [found] = read(
    lines(
      assistant({
        type: "tool_use",
        name: "Bash",
        input: { command: "gh auth login --with-token ghs_secret1" },
      }),
    ),
  );
  assert.equal(found?.summary, "Bash: gh auth login --with-token [hidden]");
  assert.doesNotMatch(found.text, /ghs_secret1/);
});

await test("CLV-329 an escape sequence at the end of a text and an escape with one character leave no control characters", () => {
  const [found] = read(lines(toolResult("a\u001b(Bb\u001b[1\u001b]2")));
  assert.equal(found?.text, "ab");
  const [unclosed] = read(lines(toolResult("c\u001b]0;title")));
  assert.equal(unclosed?.text, "c");
  const [ended] = read(lines(toolResult("d\u001b")));
  assert.equal(ended?.text, "d");
  const [terminated] = read(lines(toolResult("e\u001b]0;t\u001b\\f\u0085g")));
  assert.equal(terminated?.text, "efg");
});

await test("CLV-329 a JSON line that is not an object becomes a raw notice", () => {
  assert.deepEqual(read(lines("[1,2]")), [
    entry(1, { kind: "notice", text: "[1,2]" }),
  ]);
});
