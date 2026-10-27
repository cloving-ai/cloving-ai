import assert from "node:assert/strict";
import { test } from "node:test";
import { grokResultFields, grokUsageWarnings } from "../src/grok-result.ts";
import {
  grokResult,
  grokUsage,
  incompleteWarning,
} from "./grok-worker-fixture.ts";

await test("CLV-213 malformed token buckets never become billable usage", () => {
  for (const field of Object.keys(grokUsage)) {
    for (const value of [
      undefined,
      -1,
      1.5,
      "3",
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const result = grokResultFields({
        ...grokResult,
        usage: { ...grokUsage, [field]: value },
      });
      assert.deepEqual(result.usage, {
        input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens: null,
      });
      assert.equal(result.pricingModel, null);
    }
  }
  assert.equal(grokResultFields(null).failed, true);
  assert.equal(
    grokResultFields({
      ...grokResult,
      usage: { ...grokUsage, input_tokens: Number.MAX_SAFE_INTEGER },
    }).usage.input_tokens,
    null,
  );
});

await test("CLV-213 incomplete-usage warnings survive chunk boundaries and later diagnostics", () => {
  const warnings = grokUsageWarnings();
  warnings.write("WARN unrelated diagnostic");
  assert.equal(warnings.incomplete(), false);
  for (const chunk of incompleteWarning) warnings.write(chunk);
  assert.equal(warnings.incomplete(), true);
  warnings.write("another diagnostic".repeat(100));
  assert.equal(warnings.incomplete(), true);
});
