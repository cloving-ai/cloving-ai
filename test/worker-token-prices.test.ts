import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Worker } from "../src/daemon/claude-turn.ts";
import type { TokenPrices } from "../src/token-prices.ts";
import { parseTokenPrices } from "../src/token-prices.ts";
import {
  intent,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const price = { input: 2, cachedInput: 0.5, output: 8 };
const usage = {
  input_tokens: 1_000_000,
  cache_read_input_tokens: 400_000,
  output_tokens: 100_000,
};

async function pricedTurn(
  scene: Scene,
  options: {
    readonly worker: Worker;
    readonly events: readonly unknown[];
    readonly model?: string;
    readonly prices?: TokenPrices;
  },
) {
  const script = join(scene.directory, "priced-worker.mjs");
  writeFileSync(
    script,
    `for await (const chunk of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(options.events.map((event) => JSON.stringify(event)).join("\n"))});`,
  );
  const worker = scene.worker("complete", {
    worker: options.worker,
    tokenPrices: options.prices ?? {},
    command: [
      process.execPath,
      script,
      ...(options.model === undefined ? [] : ["--model", options.model]),
    ],
  });
  await worker.deliver(intent(), new AbortController().signal);
  await until(() => scene.reports.length === 1);
  return resultOf(scene.reports[0]?.result);
}

await test("CLV-105 Codex uses its reported model before the command model and retains an unknown reported price", () =>
  withScene(async (scene) => {
    const report = await pricedTurn(scene, {
      worker: "codex",
      model: "fallback",
      prices: { reported: price },
      events: [
        { type: "thread.started", thread_id: "thread", model: "reported" },
        {
          type: "turn.completed",
          usage: {
            input_tokens: usage.input_tokens,
            cached_input_tokens: usage.cache_read_input_tokens,
            output_tokens: usage.output_tokens,
          },
        },
      ],
    });
    assert.equal(report["model"], "reported");
    assert.equal(report["estimatedCostUsd"], 2.2);
    assert.equal(report["costUsd"], null);
  }));

await test("CLV-133 a Codex turn estimates from the built-in prices without a setting", () =>
  withScene(async (scene) => {
    const report = await pricedTurn(scene, {
      worker: "codex",
      model: "gpt-6.1-sol",
      prices: parseTokenPrices(undefined),
      events: [
        {
          type: "turn.completed",
          usage: {
            input_tokens: usage.input_tokens,
            cached_input_tokens: usage.cache_read_input_tokens,
            output_tokens: usage.output_tokens,
          },
        },
      ],
    });
    assert.equal(report["model"], "gpt-6.1-sol");
    assert.equal(report["estimatedCostUsd"], 2.24);
    assert.equal(report["costUsd"], null);
  }));

await test("CLV-105 Claude output models override command models and cache reads are additional", async () => {
  for (const reported of ["result", "init", "command"])
    await withScene(async (scene) => {
      const report = await pricedTurn(scene, {
        worker: "claude",
        model: "fallback",
        prices: { actual: price, fallback: price },
        events: [
          {
            type: "system",
            subtype: "init",
            ...(reported === "init" ? { model: "actual" } : {}),
          },
          {
            type: "result",
            usage,
            total_cost_usd: 0.25,
            ...(reported === "result" ? { model: "actual" } : {}),
          },
        ],
      });
      assert.equal(
        report["model"],
        reported === "command" ? "fallback" : "actual",
      );
      assert.equal(report["estimatedCostUsd"], 3);
      assert.equal(report["costUsd"], 0.25);
    });
});

await test("CLV-105 absent settings, unknown models and incomplete counts never create an estimate", async () => {
  for (const options of [
    { model: "known" },
    { model: "missing", prices: { known: price } },
    { prices: { known: price } },
    { model: "known", prices: { known: price }, usage: {} },
    { model: "known", prices: { known: price }, reported: "missing" },
  ])
    await withScene(async (scene) => {
      const report = await pricedTurn(scene, {
        worker: "claude",
        ...options,
        events: [
          {
            type: "result",
            usage: "usage" in options ? options.usage : usage,
            ...("reported" in options ? { model: options.reported } : {}),
          },
        ],
      });
      assert.equal(report["estimatedCostUsd"], null);
    });
});
