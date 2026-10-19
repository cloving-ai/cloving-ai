import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityRefusal, streamResult } from "../src/daemon/claude-turn.ts";

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
