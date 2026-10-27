import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorStream } from "../src/daemon/cursor-stream.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";
import { estimatedCostUsd } from "../src/token-prices.ts";
import { usageOf, sumUsage } from "../src/worker-usage.ts";
import { usageText } from "../src/cli/usage-render.ts";
import { cursorFixture } from "./cursor-fixture.ts";

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
