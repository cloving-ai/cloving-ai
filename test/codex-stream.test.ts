import assert from "node:assert/strict";
import { test } from "node:test";
import { codexStream } from "../src/daemon/codex-stream.ts";

function decoded(lines: readonly string[]): unknown[] {
  return lines.map((line): unknown => JSON.parse(line));
}

function assistant(content: Readonly<Record<string, unknown>>) {
  return { type: "assistant", message: { content: [content] } };
}

function completed(item: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ type: "item.completed", item });
}

await test("CLV-083 translates the Codex thread and completed agent messages", () => {
  const stream = codexStream();
  assert.deepEqual(
    stream.line('{"type":"thread.started","thread_id":"thread-1"}'),
    ['{"type":"system","subtype":"init","session_id":"thread-1"}'],
  );
  assert.deepEqual(
    stream.line(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
    ),
    [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Done." }] },
      }),
    ],
  );
});

await test("CLV-083 shows command starts and file changes, with no error for a successful command", () => {
  const stream = codexStream();
  assert.deepEqual(
    decoded(
      stream.line(
        '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}',
      ),
    ),
    [
      assistant({
        type: "tool_use",
        name: "Bash",
        input: { command: "npm test" },
      }),
    ],
  );
  assert.deepEqual(
    stream.line(
      completed({
        type: "command_execution",
        status: "completed",
        exit_code: 0,
      }),
    ),
    [],
  );
  assert.deepEqual(
    decoded(
      stream.line(
        completed({
          type: "file_change",
          changes: [
            { path: "src/one.ts", kind: "update" },
            { path: "src/two.ts", kind: "delete" },
          ],
        }),
      ),
    ),
    [
      assistant({
        type: "tool_use",
        name: "Edit",
        input: { file_path: "src/one.ts" },
      }),
      assistant({
        type: "tool_use",
        name: "Edit",
        input: { file_path: "src/two.ts" },
      }),
    ],
  );
});

await test("CLV-083 shows the tail of failed commands and falls back to their exit code or status", () => {
  const cases = [
    {
      fields: { exit_code: 1, aggregated_output: "x".repeat(2100) + "tail" },
      content: "x".repeat(1996) + "tail",
    },
    { fields: { exit_code: 2, aggregated_output: "" }, content: "exit code 2" },
    { fields: { status: "failed" }, content: "command failed" },
    { fields: { status: "failed", exit_code: 0 }, content: "exit code 0" },
  ];
  for (const { fields, content } of cases)
    assert.deepEqual(
      decoded(
        codexStream().line(completed({ type: "command_execution", ...fields })),
      ),
      [
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", is_error: true, content }],
          },
        },
      ],
    );
});

await test("CLV-083 ignores other events, malformed JSON and unrelated item states", () => {
  const lines = [
    "not JSON",
    "null",
    "[]",
    "42",
    "{}",
    '{"type":"turn.started"}',
    '{"type":"item.updated"}',
    '{"type":"item.started","item":{"type":"agent_message","text":"partial"}}',
    completed({ type: "reasoning", text: "thinking" }),
    completed({ type: "file_change" }),
    completed({ type: "command_execution" }),
  ];
  for (const line of lines) assert.deepEqual(codexStream().line(line), []);
});

await test("CLV-083 completes with the last agent message, the thread ID and the number of completed turns", () => {
  const stream = codexStream();
  stream.line('{"type":"thread.started","thread_id":"thread-2"}');
  stream.line(completed({ type: "agent_message", text: "First." }));
  stream.line('{"type":"turn.completed"}');
  stream.line(completed({ type: "agent_message", text: "Last." }));
  stream.line(
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
  );
  assert.deepEqual(decoded([stream.result(0)]), [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Last.",
      total_cost_usd: null,
      session_id: "thread-2",
      num_turns: 2,
    },
  ]);
});

await test("CLV-083 requires a completed turn, a zero exit code and no failure event for success", () => {
  const cases = [
    {
      lines: ['{"type":"turn.failed","error":{"message":"Turn failed."}}'],
      exitCode: 0,
      result: "Turn failed.",
      turns: 0,
    },
    {
      lines: ['{"type":"turn.completed"}'],
      exitCode: 1,
      result: "codex ended with the code 1",
      turns: 1,
    },
    { lines: [], exitCode: 0, result: "codex ended with the code 0", turns: 0 },
    {
      lines: [
        '{"type":"error","message":"Stream error."}',
        '{"type":"turn.completed"}',
      ],
      exitCode: 0,
      result: "Stream error.",
      turns: 1,
    },
    {
      lines: ['{"type":"turn.failed"}', '{"type":"turn.completed"}'],
      exitCode: 0,
      result: "codex ended with the code 0",
      turns: 1,
    },
    {
      lines: ['{"type":"error"}'],
      exitCode: null,
      result: "codex ended with the code null",
      turns: 0,
    },
  ];
  for (const { lines, exitCode, result, turns } of cases) {
    const stream = codexStream();
    for (const line of lines) assert.deepEqual(stream.line(line), []);
    assert.deepEqual(decoded([stream.result(exitCode)]), [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result,
        total_cost_usd: null,
        session_id: null,
        num_turns: turns,
      },
    ]);
  }
});
