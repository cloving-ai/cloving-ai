import assert from "node:assert/strict";
import { test } from "node:test";
import { piStream } from "../src/daemon/pi-stream.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import { piEvents, piMessage, piReport } from "./pi-fixture.ts";
import { read } from "./turn-transcript-fixture.ts";

function parsed(events: readonly unknown[], exitCode = 0) {
  const stream = piStream();
  const lines = events.flatMap((event) => stream.line(JSON.stringify(event)));
  const result = resultOf(stream.result(exitCode));
  return { lines, result };
}

await test("CLV-364 Pi accepts later work after agent_end only with a fresh settlement", () => {
  const first = piMessage({ stopReason: "error", errorMessage: "Retry me" });
  const last = piMessage({ responseId: "response-2", timestamp: 2 });
  const beforeSettlement = [
    ...piEvents(first).slice(0, -1),
    { type: "auto_retry_start", attempt: 1 },
    ...piEvents(last).slice(1, -1),
  ];
  assert.equal(parsed(beforeSettlement).result["is_error"], true);
  assert.equal(
    parsed([...beforeSettlement, { type: "agent_settled", aborted: false }])
      .result["is_error"],
    false,
  );
  assert.equal(
    parsed([...piEvents(), { type: "agent_start" }]).result["is_error"],
    true,
  );
});

await test("CLV-364 Pi rejects empty, malformed and truncated required records", () => {
  for (const events of [
    [],
    [{ type: "agent_settled", aborted: false }],
    [...piEvents().slice(0, -1), { type: "agent_settled" }],
    [{ type: "session", version: 99, id: "future" }, ...piEvents().slice(1)],
    [
      ...piEvents().slice(0, -1),
      { type: "message_end", message: { role: "assistant" } },
      { type: "agent_settled", aborted: false },
    ],
  ]) {
    const result = parsed(events).result;
    assert.equal(result["is_error"], true);
    assert.match(
      String(result["result"]),
      /Pi.*(session|record|assistant|settled)/,
    );
  }
  for (const line of ["{", "[]", "null", "{}", "", '{"type":3}']) {
    const stream = piStream();
    assert.doesNotThrow(() => stream.line(line));
    assert.equal(resultOf(stream.result(0))["is_error"], true);
    assert.match(String(resultOf(stream.result(0))["result"]), /record/);
  }
});

await test("CLV-364 Pi ignores unrelated well-formed events without accepting foreign completions", () => {
  assert.equal(
    parsed([
      { type: "session", version: 3, id: "session" },
      { type: "result", is_error: false },
    ]).result["is_error"],
    true,
  );
  assert.equal(
    parsed([
      ...piEvents().slice(0, -1),
      { type: "future_activity", value: "fine" },
      { type: "agent_settled", aborted: false },
    ]).result["is_error"],
    false,
  );
});

await test("CLV-364 authoritative Pi messages and tool output appear once", () => {
  const message = piMessage();
  const { lines } = parsed([
    ...piEvents().slice(0, 3),
    {
      type: "message_update",
      usage: message.usage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Obsolete delta",
      },
    },
    {
      type: "message_update",
      usage: message.usage,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Obsolete block",
      },
    },
    { type: "message_end", message },
    ...piEvents().slice(4),
  ]);
  const output = read(lines.join("\n") + "\n")
    .map((entry) => entry.text)
    .join("\n");
  assert.equal(output.includes("Obsolete"), false);
  assert.equal(output.match(/Implemented the change/g)?.length, 1);
});

await test("CLV-364 Pi tool output replaces partial and duplicate tool records", () => {
  const { lines } = parsed([
    ...piEvents().slice(0, 2),
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "check" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "check" },
      partialResult: { content: [{ type: "text", text: "old output" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Final output" }] },
      isError: true,
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "call-1",
        content: [{ type: "text", text: "Final output" }],
        isError: true,
      },
    },
    ...piEvents().slice(2),
  ]);
  const entries = read(lines.join("\n") + "\n");
  const output = entries.map((entry) => entry.text).join("\n");
  assert.equal(output.includes("old output"), false);
  assert.equal(output.match(/Final output/g)?.length, 1);
  assert.equal(output.match(/Implemented the change/g)?.length, 1);
  assert.equal(entries.filter((entry) => entry.kind === "tool-call").length, 1);
  assert.equal(
    entries.some((entry) => entry.kind === "tool-result" && entry.error),
    true,
  );
});

await test("CLV-364 Pi accounts completed responses once and preserves primary and nested usage", () => {
  const first = piMessage({ stopReason: "toolUse" });
  const second = piMessage({ responseId: "response-2", timestamp: 2 });
  const result = parsed([
    ...piEvents(first).slice(0, -1),
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "bash",
        usage: first.usage,
        toolCallId: "nested",
        content: [],
        isError: false,
      },
    },
    ...piEvents(second).slice(1),
  ]).result;
  assert.deepEqual(result["usage"], {
    input_tokens: 200,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
    output_tokens: 40,
  });
  assert.equal(result["num_turns"], 2);
  assert.equal(result["total_cost_usd"], null);
  assert.equal(result["pricingModel"], null);
  const accounting = resultOf(JSON.stringify(result["piAccounting"]));
  assert.equal(accounting["scope"], "primary-model");
  assert.deepEqual(accounting["nestedUsage"], {
    input_tokens: 100,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
  });
  const responses = accounting["responses"];
  assert.ok(Array.isArray(responses));
  assert.equal(responses.length, 2);
  const response = resultOf(JSON.stringify(responses[0]));
  assert.equal(response["provider"], "test-provider");
  assert.equal(response["model"], "test-model");
  assert.equal(response["reportedEstimateUsd"], 6);
  assert.equal(response["costSource"], "pi-reported-estimate");
});

await test("CLV-364 Pi leaves missing counts and mixed model pricing unknown", () => {
  const missing = parsed(piEvents(piMessage({ usage: { input: 1 } }))).result;
  assert.deepEqual(missing["usage"], {
    input_tokens: 1,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    output_tokens: null,
  });
  const mixed = parsed([
    ...piEvents().slice(0, -1),
    ...piEvents(piMessage({ model: "other", responseId: "second" })).slice(1),
  ]).result;
  assert.equal(mixed["pricingModel"], null);
  assert.equal(parsed(piEvents()).result["model"], "test-provider/test-model");
  assert.equal(parsed(piEvents()).result["result"], piReport);
});

await test("CLV-364 malformed Pi activity cannot hide behind a successful settlement", () => {
  for (const event of [
    { type: "message_start" },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: 2 },
    },
    { type: "tool_execution_start", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "broken", isError: false },
    {
      type: "tool_execution_end",
      toolCallId: "bad",
      toolName: "bash",
      isError: false,
      result: { content: [null] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "",
      toolName: "bash",
      isError: false,
      result: { content: [] },
    },
  ]) {
    const result = parsed([
      ...piEvents().slice(0, -1),
      event,
      { type: "agent_settled", aborted: false },
    ]).result;
    assert.equal(result["is_error"], true);
    assert.match(String(result["result"]), /malformed.*record/);
  }
});

await test("CLV-364 aborts remain failures and tool result duplicates retain nested accounting once", () => {
  assert.equal(
    parsed([
      ...piEvents().slice(0, -1),
      { type: "agent_settled", aborted: true },
      { type: "agent_settled", aborted: false },
    ]).result["is_error"],
    true,
  );
  const tool = {
    role: "toolResult",
    toolName: "bash",
    toolCallId: "nested",
    usage: piMessage().usage,
    content: [],
    isError: false,
  };
  const result = parsed([
    ...piEvents().slice(0, -1),
    {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "nested",
      result: { content: [] },
      isError: false,
    },
    { type: "message_end", message: tool },
    { type: "message_end", message: tool },
    { type: "agent_settled", aborted: false },
  ]).result;
  assert.equal(result["pricingModel"], null);
  const accounting = resultOf(JSON.stringify(result["piAccounting"]));
  assert.deepEqual(accounting["nestedUsage"], {
    input_tokens: 100,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 20,
  });
});

await test("CLV-364 Pi accepts billed totals only with the pinned provider billing flag", () => {
  const base = piMessage();
  const billed = piMessage({
    usage: {
      ...base.usage,
      cost: { ...base.usage.cost, total: 7, totalFromProvider: true },
    },
  });
  const result = parsed(piEvents(billed)).result;
  assert.equal(result["total_cost_usd"], 7);
  const estimate = parsed(piEvents(base)).result;
  assert.equal(estimate["total_cost_usd"], null);
  const accounting = resultOf(JSON.stringify(result["piAccounting"]));
  const responses = accounting["responses"];
  assert.ok(Array.isArray(responses));
  const response = resultOf(JSON.stringify(responses[0]));
  assert.equal(response["costSource"], "pi-provider-billed");
  assert.equal(response["reportedBilledCostUsd"], 7);
  assert.equal(response["reportedEstimateUsd"], null);
});

await test("CLV-364 Pi cannot reuse a successful assistant for later empty work or failed retries", () => {
  for (const event of [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "auto_retry_end", success: false, finalError: "Retry exhausted" },
  ]) {
    const result = parsed([
      ...piEvents().slice(0, -1),
      event,
      { type: "agent_settled", aborted: false },
    ]).result;
    assert.equal(result["is_error"], true);
    assert.match(String(result["result"]), /assistant|Retry exhausted/);
  }
});

await test("CLV-364 Pi rejects malformed tool results and incomplete nested billing", () => {
  const malformed = parsed([
    ...piEvents().slice(0, -1),
    { type: "message_end", message: { role: "toolResult" } },
    { type: "agent_settled", aborted: false },
  ]).result;
  assert.equal(malformed["is_error"], true);
  const base = piMessage();
  const billed = piMessage({
    usage: {
      ...base.usage,
      cost: { ...base.usage.cost, totalFromProvider: true },
    },
  });
  const result = parsed([
    ...piEvents(billed).slice(0, -1),
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "nested",
        content: [],
        isError: false,
        nestedCalls: { complete: false, calls: [] },
      },
    },
    { type: "agent_settled", aborted: false },
  ]).result;
  assert.equal(result["is_error"], false);
  assert.equal(result["total_cost_usd"], null);
  assert.equal(result["pricingModel"], null);
});
