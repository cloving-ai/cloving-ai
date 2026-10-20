import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTokenPrices } from "../src/token-prices.ts";
import {
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { fallbackCommand } from "./fallback-worker-fixture.ts";

await test("CLV-139 usage and cost estimates retain each attempt model and its own token price", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      worker: "codex",
      command: fallbackCommand(scene),
      fallbackModels: ["gpt-6-astra"],
      tokenPrices: parseTokenPrices(undefined),
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = resultOf(scene.reports[0]?.result);
    assert.ok(Math.abs(Number(report["estimatedCostUsd"]) - 40.92) < 1e-12);
    const attempts = ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6-astra"].map(
      (model, index) => ({
        attempt: index + 1,
        model,
        usage: {
          input_tokens: (index + 1) * 1_000_000,
          cache_read_input_tokens: (index + 1) * 400_000,
          output_tokens: (index + 1) * 100_000,
        },
        costUsd: null,
        estimatedCostUsd: [2.24, 4.48, 34.2][index],
      }),
    );
    assert.deepEqual(report["attempts"], attempts);
    for (const attempt of attempts) {
      const saved = record(
        scene,
        `operation-1/attempt-${String(attempt.attempt)}.json`,
      );
      for (const [name, value] of Object.entries(attempt))
        assert.deepEqual(field(saved, name), value);
    }
    assert.deepEqual(report["usage"], {
      input_tokens: 6_000_000,
      cache_read_input_tokens: 2_400_000,
      output_tokens: 600_000,
    });
    assert.equal(report["costUsd"], null);
  }));
