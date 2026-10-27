import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capacityRefusal,
  retryKind,
  streamResult,
} from "../src/daemon/claude-turn.ts";

const capacity = "Selected model is at capacity. Please try a different model.";

await test("CLV-127 only fixed provider capacity failures permit a retry", () => {
  const result = (fields: Readonly<Record<string, unknown>>) =>
    streamResult(JSON.stringify({ type: "result", is_error: true, ...fields }));
  assert.equal(capacityRefusal(result({ result: capacity })), true);
  assert.equal(capacityRefusal(result({ error: "overloaded" })), true);
  for (const fields of [
    { result: "Something failed" },
    { result: `quoted: ${capacity}` },
    { result: "overloaded" },
    { error: "rate_limit" },
    { error: "server_error" },
    { result: capacity, is_error: false },
    { error: "overloaded", is_error: false },
    { is_error: false, result: "Done" },
    { subtype: "error_max_budget_usd", error: "overloaded" },
    { subtype: "error_max_turns", result: capacity },
    { subtype: "error_max_structured_output_retries", error: "overloaded" },
  ])
    assert.equal(capacityRefusal(result(fields)), false);
  assert.equal(capacityRefusal(undefined), false);
});

await test("CLV-229 unreachable API failures are network failures, never capacity refusals", () => {
  const network = streamResult(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      result: "API Error: Can't reach the API server ... (ENOTFOUND)",
    }),
  );
  assert.equal(capacityRefusal(network), false);
  assert.equal(retryKind(network), "network");
});

await test("CLV-229 network classification requires a failed result and the exact leading text", () => {
  for (const fields of [
    { result: "API Error: 400 invalid request" },
    { result: "API Error: server failed" },
    { result: "quoted: API Error: Can't reach the API server" },
    { result: "API Error: Can't reach the API server", is_error: false },
  ]) {
    const result = streamResult(
      JSON.stringify({
        type: "result",
        is_error: true,
        terminal_reason: "api_error",
        ...fields,
      }),
    );
    assert.equal(retryKind(result), null);
  }
  assert.equal(retryKind(undefined), null);
});

await test("CLV-229 a network result takes precedence over a retained assistant overload", () => {
  const result = streamResult(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      error: "overloaded",
      result: "API Error: Can't reach the API server ... (ENOTFOUND)",
    }),
  );
  assert.equal(retryKind(result), "network");
  assert.equal(capacityRefusal(result), false);
});
