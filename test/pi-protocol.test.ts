import assert from "node:assert/strict";
import { test } from "node:test";
import { validPiActivity } from "../src/daemon/pi-records.ts";
import { piStream } from "../src/daemon/pi-stream.ts";
import {
  piAccountingOf,
  piBilledCost,
  piPricingModel,
  piResponse,
  piUsage,
} from "../src/pi-usage.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import { piEvents, piMessage } from "./pi-fixture.ts";

await test("CLV-364 Pi validates every documented streaming block update shape", () => {
  const updates = [
    ...["start", "done", "error"].map((type) => ({ type })),
    ...["text_start", "thinking_start", "toolcall_start"].map((type) => ({
      type,
      contentIndex: 0,
    })),
    ...["text_delta", "thinking_delta", "toolcall_delta"].map((type) => ({
      type,
      contentIndex: 0,
      delta: "text",
    })),
    ...["text_end", "thinking_end"].map((type) => ({
      type,
      contentIndex: 0,
      content: "text",
    })),
    {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "call", name: "bash", arguments: {} },
    },
  ];
  for (const update of updates)
    assert.equal(
      validPiActivity({
        type: "message_update",
        assistantMessageEvent: update,
      }),
      true,
    );
  for (const update of [
    undefined,
    {},
    { type: 2 },
    { type: "text_delta", delta: "text" },
    { type: "text_end", contentIndex: 0 },
    { type: "toolcall_end", contentIndex: 0 },
    { type: "unknown", contentIndex: 0 },
  ])
    assert.equal(
      validPiActivity({
        type: "message_update",
        assistantMessageEvent: update,
      }),
      false,
    );
});

await test("CLV-364 Pi rejects invalid assistant bodies and incomplete assistant messages", () => {
  for (const content of [
    null,
    [null],
    [{ type: "text", text: 2 }],
    [{ type: "image" }],
    [{ type: "toolCall", id: "id" }],
  ]) {
    const stream = piStream();
    for (const event of piEvents(piMessage({ content })))
      stream.line(JSON.stringify(event));
    assert.match(
      String(resultOf(stream.result(0))["result"]),
      /malformed assistant/,
    );
  }
  const stream = piStream();
  for (const event of piEvents().slice(0, 3))
    stream.line(JSON.stringify(event));
  stream.line('{"type":"agent_settled","aborted":false}');
  assert.match(
    String(resultOf(stream.result(0))["result"]),
    /incomplete assistant/,
  );
});

await test("CLV-364 Pi renders thinking and admits valid tool-call content without duplicating execution", () => {
  const content = [
    { type: "thinking", thinking: "Consider the change." },
    { type: "thinking", redacted: true },
    {
      type: "toolCall",
      id: "call",
      name: "bash",
      arguments: { command: "check" },
    },
    { type: "text", text: "Done" },
  ];
  const stream = piStream();
  const lines = piEvents(piMessage({ content, responseId: undefined })).flatMap(
    (event) => stream.line(JSON.stringify(event)),
  );
  assert.equal(resultOf(stream.result(0))["result"], "Done");
  assert.match(lines.join("\n"), /Consider the change/);
  assert.equal(lines.join("\n").includes('"type":"tool_use"'), false);
});

await test("CLV-364 Pi accounts retries with distinct and duplicate response identities once", () => {
  const first = piMessage({ stopReason: "error" });
  const second = piMessage({ responseId: "second" });
  const stream = piStream();
  const events = [
    ...piEvents(first).slice(0, -1),
    ...piEvents(second).slice(1, -1),
    { type: "message_end", message: second },
    { type: "agent_settled", aborted: false },
  ];
  for (const event of events) stream.line(JSON.stringify(event));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["num_turns"], 2);
  assert.deepEqual(result["usage"], {
    input_tokens: 200,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
    output_tokens: 40,
  });
});

await test("CLV-364 Pi cost and identity normalization keep absent or invalid data unknown", () => {
  assert.equal(piResponse({}).model, null);
  assert.equal(
    piResponse({ responseModel: "actual", model: "alias" }).model,
    "actual",
  );
  assert.deepEqual(
    piUsage({ input: -1, output: 1.5, cacheRead: "3", cacheWrite: null }),
    {
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
  );
  const usage = piMessage().usage;
  for (const cost of [
    {},
    { ...usage.cost, total: 99 },
    { ...usage.cost, input: -1 },
  ])
    assert.equal(
      piResponse({ usage: { ...usage, cost } }).reportedEstimateUsd,
      null,
    );
  assert.equal(
    piResponse({ usage: { cost: { total: 10, totalFromProvider: true } } })
      .reportedBilledCostUsd,
    null,
  );
  assert.equal(
    piPricingModel({
      scope: "primary-model",
      responses: [piResponse({})],
      auxiliaryWork: false,
      nestedUsage: null,
    }),
    null,
  );
});

await test("CLV-364 Pi accounting deserialization preserves nested scope and rejects foreign metadata", () => {
  for (const value of [
    undefined,
    null,
    {},
    { scope: "primary-model", responses: 2 },
  ])
    assert.equal(piAccountingOf(value), undefined);
  const accounting = piAccountingOf({
    scope: "primary-model",
    responses: [null],
    nestedUsage: {},
  });
  assert.ok(accounting);
  assert.equal(accounting.auxiliaryWork, true);
  assert.equal(accounting.responses[0]?.usage.input_tokens, null);
  assert.equal(accounting.nestedUsage?.output_tokens, null);
  assert.equal(piBilledCost(accounting), null);
});
