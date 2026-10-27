import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorStream } from "../src/daemon/cursor-stream.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";
import { estimatedCostUsd } from "../src/token-prices.ts";
import { usageOf, sumUsage } from "../src/worker-usage.ts";
import { usageText } from "../src/cli/usage-render.ts";
import { cursorFixture } from "./cursor-fixture.ts";
import { activityOf } from "../src/cli/watch-model.ts";

await test("CLV-214 documented Cursor file tools reach watch activity once per call", () => {
  const stream = cursorStream();
  const fixture = cursorFixture("completed").split("\n");
  const activity = fixture.flatMap(stream.line).flatMap(activityOf);
  assert.ok(
    activity.some(
      (item) => item.kind === "tool" && item.text === "Write: change.txt",
    ),
  );
  const started = {
    type: "tool_call",
    subtype: "started",
    call_id: "read-1",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
  };
  assert.deepEqual(stream.line(JSON.stringify(started)).flatMap(activityOf), [
    { kind: "tool", text: "Read: README.md" },
  ]);
  assert.deepEqual(
    stream
      .line(JSON.stringify({ ...started, subtype: "completed" }))
      .flatMap(activityOf),
    [],
  );
  assert.equal(
    streamResult(stream.result(0))?.text,
    "Implemented the change.\nTicket status: complete",
  );
});

await test("CLV-214 Cursor commands and edits reach the shared tool activity reader", () => {
  const stream = cursorStream();
  for (const [key, args, expected] of [
    ["shellToolCall", { command: "npm test" }, "Bash: npm test"],
    ["editToolCall", { path: "src/index.ts" }, "Edit: src/index.ts"],
  ] as const) {
    const event = {
      type: "tool_call",
      subtype: "started",
      call_id: key,
      tool_call: { [key]: { args } },
    };
    assert.deepEqual(stream.line(JSON.stringify(event)).flatMap(activityOf), [
      { kind: "tool", text: expected },
    ]);
    assert.deepEqual(
      stream
        .line(JSON.stringify({ ...event, subtype: "completed" }))
        .flatMap(activityOf),
      [],
    );
  }
});

await test("CLV-214 documented Cursor function tools show activity and malformed tools stay ignored", () => {
  const stream = cursorStream();
  const event = {
    type: "tool_call",
    subtype: "started",
    call_id: "function-1",
    tool_call: {
      function: { name: "Grep", arguments: '{"pattern":"needle"}' },
    },
  };
  assert.deepEqual(stream.line(JSON.stringify(event)).flatMap(activityOf), [
    { kind: "tool", text: "Grep: needle" },
  ]);
  for (const tool_call of [
    null,
    {},
    { writeToolCall: {} },
    { function: { name: "Grep", arguments: "invalid" } },
  ]) {
    assert.deepEqual(
      stream
        .line(
          JSON.stringify({ type: "tool_call", subtype: "started", tool_call }),
        )
        .flatMap(activityOf),
      [],
    );
  }
});

await test("CLV-214 only assistant text blocks update the Cursor report", () => {
  const stream = cursorStream();
  for (const line of ["not JSON", "null", "[]", "{}"]) stream.line(line);
  stream.line(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Report." },
          { type: "tool_use", text: "Ignore." },
          { type: "text", text: 7 },
        ],
      },
    }),
  );
  stream.line(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use" }] },
    }),
  );
  stream.line(JSON.stringify({ type: "assistant", message: {} }));
  stream.line(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Aggregated text.",
    }),
  );
  assert.equal(streamResult(stream.result(0))?.text, "Report.");
});

await test("CLV-214 Cursor requires both explicit success fields and a clean exit", () => {
  for (const fields of [
    {},
    { subtype: "success" },
    { is_error: false },
    { subtype: "error", is_error: false },
    { subtype: "success", is_error: true },
    { subtype: "success", is_error: "false" },
  ]) {
    const stream = cursorStream();
    stream.line(JSON.stringify({ type: "result", ...fields }));
    assert.equal(streamResult(stream.result(0))?.failed, true);
  }
  const stream = cursorStream();
  stream.line('{"type":"error"}');
  assert.equal(
    streamResult(stream.result(null))?.text,
    "cursor-agent stream error",
  );
});

await test("CLV-214 known cache writes survive totals and appear in usage text", () => {
  const counts = {
    input_tokens: 7,
    cache_read_input_tokens: 11,
    cache_creation_input_tokens: 13,
    output_tokens: 17,
  };
  assert.deepEqual(sumUsage([counts, counts]), {
    input_tokens: 14,
    cache_read_input_tokens: 22,
    cache_creation_input_tokens: 26,
    output_tokens: 34,
  });
  assert.equal(
    sumUsage([counts, usageOf(null)]).cache_creation_input_tokens,
    null,
  );
  assert.match(usageText(counts), /Cache write tokens: 13/);
});

function normalized(usage: unknown) {
  const stream = cursorStream();
  for (const line of cursorFixture("completed").split("\n")) {
    const event: unknown = JSON.parse(line);
    assert.ok(typeof event === "object" && event !== null);
    stream.line(JSON.stringify({ ...event, usage }));
  }
  const result = streamResult(stream.result(0));
  assert.ok(result);
  return result;
}

await test("CLV-214 Cursor camel-case terminal counts follow the published uncached and cache-write rules", () => {
  const result = normalized({
    inputTokens: 7,
    cacheReadTokens: 147695,
    cacheWriteTokens: 39331,
    outputTokens: 100,
  });
  assert.deepEqual(result.usage, {
    input_tokens: 7,
    cache_read_input_tokens: 147695,
    cache_creation_input_tokens: 39331,
    output_tokens: 100,
  });
  assert.equal(result.costUsd, null);
  assert.equal(
    estimatedCostUsd(result.usage, {
      worker: "cursor-agent",
      price: { input: 2, cachedInput: 0.5, output: 8 },
    }),
    null,
  );
});

await test("CLV-214 Cursor estimates known prices with zero cache writes using additional cache reads", () => {
  const result = normalized({
    inputTokens: 1000000,
    cacheReadTokens: 400000,
    cacheWriteTokens: 0,
    outputTokens: 100000,
  });
  assert.equal(
    estimatedCostUsd(result.usage, {
      worker: "cursor-agent",
      price: { input: 2, cachedInput: 0.5, output: 8 },
    }),
    3,
  );
});

await test("CLV-214 undocumented or incomplete Cursor usage stays entirely unknown", () => {
  for (const usage of [
    undefined,
    null,
    [],
    {},
    { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 },
    { inputTokens: 1, outputTokens: 2 },
    {
      inputTokens: -1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 2,
    },
    {
      inputTokens: 1,
      cacheReadTokens: "0",
      cacheWriteTokens: 0,
      outputTokens: 2,
    },
  ]) {
    const result = normalized(usage);
    assert.deepEqual(result.usage, usageOf(null));
    assert.equal(
      estimatedCostUsd(result.usage, {
        worker: "cursor-agent",
        price: { input: 2, cachedInput: 0.5, output: 8 },
      }),
      null,
    );
  }
});
