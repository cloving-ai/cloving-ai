import assert from "node:assert/strict";
import { test } from "node:test";
import { codexStream } from "../src/daemon/codex-stream.ts";

const unknownUsage = {
  input_tokens: null,
  cache_read_input_tokens: null,
  output_tokens: null,
};

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
      usage: unknownUsage,
      session_id: "thread-2",
      num_turns: 2,
    },
  ]);
});

await test("CLV-087 completes with the last agent message after a recovered error", () => {
  const stream = codexStream();
  stream.line('{"type":"thread.started","thread_id":"thread-1"}');
  stream.line(completed({ type: "agent_message", text: "Working." }));
  assert.deepEqual(
    stream.line('{"type":"error","message":"Reconnecting... 3/5"}'),
    [],
  );
  stream.line(completed({ type: "agent_message", text: "Done." }));
  stream.line('{"type":"turn.completed"}');
  assert.deepEqual(decoded([stream.result(0)]), [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      total_cost_usd: null,
      usage: unknownUsage,
      session_id: "thread-1",
      num_turns: 1,
    },
  ]);
});

await test("CLV-087 requires completion, zero exit, no failed turn and no error after the last completion", () => {
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
        '{"type":"turn.completed"}',
        '{"type":"error","message":"Stream error."}',
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
        usage: unknownUsage,
        session_id: null,
        num_turns: turns,
      },
    ]);
  }
});

await test("CLV-087 clears errors on each completion and keeps failures permanent", () => {
  const cases = [
    {
      events: [
        { type: "turn.completed" },
        { type: "error", message: "Reconnecting." },
        { type: "turn.completed" },
      ],
      failed: false,
      result: "Done.",
    },
    {
      events: [
        { type: "turn.failed", error: { message: "Turn failed." } },
        { type: "turn.completed" },
        { type: "error", message: "Later error." },
      ],
      failed: true,
      result: "Turn failed.",
    },
    {
      events: [
        { type: "turn.completed" },
        { type: "error", message: "First error." },
        { type: "error", message: "Last error." },
      ],
      failed: true,
      result: "Last error.",
    },
  ];
  for (const { events, failed, result } of cases) {
    const stream = codexStream();
    stream.line(completed({ type: "agent_message", text: "Done." }));
    for (const event of events)
      assert.deepEqual(stream.line(JSON.stringify(event)), []);
    assert.deepEqual(decoded([stream.result(0)]), [
      {
        type: "result",
        subtype: failed ? "error_during_execution" : "success",
        is_error: failed,
        result,
        total_cost_usd: null,
        usage: unknownUsage,
        session_id: null,
        num_turns: events.filter((event) => event.type === "turn.completed")
          .length,
      },
    ]);
  }
});

await test("CLV-087 uses the exit code when no current failure message remains", () => {
  const cases = [
    {
      events: [
        { type: "error", message: "Recovered error." },
        { type: "turn.completed" },
      ],
      exitCode: 2,
    },
    {
      events: [
        { type: "turn.completed" },
        { type: "error", message: "Earlier error." },
        { type: "error" },
      ],
      exitCode: 0,
    },
    {
      events: [
        { type: "error", message: "Recovered error." },
        { type: "turn.failed" },
        { type: "turn.completed" },
      ],
      exitCode: 0,
    },
  ];
  for (const { events, exitCode } of cases) {
    const stream = codexStream();
    for (const event of events)
      assert.deepEqual(stream.line(JSON.stringify(event)), []);
    assert.deepEqual(decoded([stream.result(exitCode)]), [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: `codex ended with the code ${String(exitCode)}`,
        total_cost_usd: null,
        usage: unknownUsage,
        session_id: null,
        num_turns: 1,
      },
    ]);
  }
});

await test("CLV-094 sums selected usage across Codex completions and retains it after failure", () => {
  for (const failure of [null, "turn.failed", "error", "exit"]) {
    const stream = codexStream();
    for (const [input_tokens, cached_input_tokens, output_tokens] of [
      [100, 40, 20],
      [200, 60, 30],
    ])
      stream.line(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens, cached_input_tokens, output_tokens },
        }),
      );
    if (failure !== null && failure !== "exit")
      stream.line(JSON.stringify({ type: failure }));
    const result: unknown = JSON.parse(
      stream.result(failure === "exit" ? 1 : 0),
    );
    assert.deepEqual(Reflect.get(Object(result), "usage"), {
      input_tokens: 300,
      cache_read_input_tokens: 100,
      output_tokens: 50,
    });
    assert.equal(Reflect.get(Object(result), "total_cost_usd"), null);
    assert.equal(Reflect.get(Object(result), "is_error"), failure !== null);
  }
});

await test("CLV-094 unknown or overflowing completion counts stay unknown independently", () => {
  for (const invalid of [
    undefined,
    null,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "4",
  ]) {
    const stream = codexStream();
    for (const input_tokens of [invalid, 10])
      stream.line(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens, cached_input_tokens: 0, output_tokens: 2 },
        }),
      );
    const result: unknown = JSON.parse(stream.result(0));
    assert.deepEqual(Reflect.get(Object(result), "usage"), {
      input_tokens: null,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    });
  }
  const stream = codexStream();
  for (const input_tokens of [Number.MAX_SAFE_INTEGER, 1])
    stream.line(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens } }),
    );
  for (const result of [stream.result(0), codexStream().result(0)])
    assert.deepEqual(Reflect.get(Object(JSON.parse(result)), "usage"), {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    });
});
