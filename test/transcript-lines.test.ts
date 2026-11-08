import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistant,
  entry,
  lines,
  read,
  toolResult,
} from "./turn-transcript-fixture.ts";

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

await test("CLV-329 a Codex JSON stream gives assistant text, thinking, a command call, its result and the end of the turn", () => {
  const found = read(
    lines(
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "reasoning", text: "Look at the tests." },
      },
      {
        type: "item.started",
        item: { id: "i2", type: "command_execution", command: "npm test" },
      },
      {
        type: "item.completed",
        item: {
          id: "i2",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "1 failed",
          exit_code: 1,
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: { id: "i3", type: "agent_message", text: "One test fails." },
      },
      { type: "turn.completed", usage: { input_tokens: 10 } },
    ),
  );
  assert.deepEqual(found, [
    entry(1, { kind: "notice", text: "Session started" }),
    entry(2, { kind: "thinking", text: "Look at the tests." }),
    entry(3, {
      kind: "tool-call",
      tool: "shell",
      summary: "shell: npm test",
      text: "npm test",
    }),
    entry(4, { kind: "tool-result", text: "1 failed", error: true }),
    entry(5, { kind: "assistant", text: "One test fails." }),
    entry(6, { kind: "result", text: "Turn end: completed · cost unknown" }),
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

const shape = (found: ReturnType<typeof read>) =>
  found.map((item) => [item.kind, item.summary, item.text, item.error]);

await test("CLV-329 Codex MCP tool calls give a call and a result with an error mark", () => {
  const found = read(
    lines(
      { type: "item.started", item: { type: "web_search", query: "x" } },
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          server: "docs",
          tool: "search",
          arguments: { query: "retention" },
        },
      },
      { type: "item.updated", item: { type: "mcp_tool_call" } },
      {
        type: "item.completed",
        item: { type: "mcp_tool_call", result: { content: "found" } },
      },
      {
        type: "item.completed",
        item: { type: "mcp_tool_call", error: { message: "refused" } },
      },
      { type: "item.completed", item: { type: "mcp_tool_call" } },
    ),
  );
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  assert.deepEqual(shape(found), [
    [
      "tool-call",
      "docs.search: retention",
      json({ query: "retention" }),
      false,
    ],
    ["tool-result", "", json({ content: "found" }), false],
    ["tool-result", "", json({ message: "refused" }), true],
    ["tool-result", "", "null", false],
  ]);
});

await test("CLV-329 Codex file changes, failures and unknown items give entries", () => {
  const unknownItem = {
    type: "item.completed",
    item: { type: "todo_list", items: [] },
  };
  const found = read(
    lines(
      {
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          aggregated_output: "ok",
          exit_code: 0,
        },
      },
      unknownItem,
      { type: "error", message: "stream lost" },
      { type: "turn.failed", error: { message: "quota" } },
      { type: "turn.failed" },
    ),
  );
  assert.deepEqual(shape(found), [
    [
      "tool-call",
      "apply_patch: src/a.ts src/b.ts",
      JSON.stringify({ file_path: "src/a.ts src/b.ts" }, null, 2),
      false,
    ],
    ["tool-result", "", "ok", false],
    ["notice", "", JSON.stringify(unknownItem), false],
    ["notice", "", "Error: stream lost", false],
    ["result", "", "Turn end: failed · cost unknown\nquota", true],
    ["result", "", "Turn end: failed · cost unknown\nerror", true],
  ]);
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

await test("CLV-329 a JSON line that is not an object becomes a raw notice, and an MCP call without arguments shows an empty input", () => {
  const found = read(
    lines("[1,2]", {
      type: "item.started",
      item: { type: "mcp_tool_call", server: "docs", tool: "list" },
    }),
  );
  assert.deepEqual(
    found.map((item) => [item.kind, item.summary || item.text]),
    [
      ["notice", "[1,2]"],
      ["tool-call", "docs.list: {}"],
    ],
  );
});
