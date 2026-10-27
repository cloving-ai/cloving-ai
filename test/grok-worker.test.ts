import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { withScene } from "./claude-worker-fixture.ts";
import {
  grokReport,
  grokTurn,
  grokResult,
  grokMessages,
  grokUsage,
  grokModelUsage,
  incompleteWarning,
} from "./grok-worker-fixture.ts";
import { priceText, usageText } from "../src/cli/usage-render.ts";

await test("CLV-213 the default grok worker passes literal turn text and commits in the worktree", () =>
  withScene(async (scene) => {
    const prompt = 'Implement "grok"\nand preserve the quotes';
    const { report, result, observed } = await grokTurn(scene, { prompt });
    assert.equal(report?.outcome, "completed");
    assert.equal(result["harness"], "grok");
    assert.equal(result["summary"], grokReport);
    assert.deepEqual(result["ticketStatus"], { kind: "complete" });
    assert.deepEqual(observed["arguments"], [
      "--output-format",
      "streaming-messages-json",
      "--always-approve",
      "-p",
      prompt,
    ]);
    assert.equal(observed["directory"], result["worktree"]);
    assert.ok(String(result["worktree"]).startsWith(scene.worktrees));
    assert.match(String(result["files"]), /grok\.txt/);
    assert.equal(
      Array.isArray(result["commits"]) && result["commits"].length,
      1,
    );
    assert.deepEqual(result["uncommitted"], []);
  }));

await test("CLV-213 terminal usage is mapped once and includes cache creation", () =>
  withScene(async (scene) => {
    const { result } = await grokTurn(scene);
    assert.deepEqual(result["usage"], {
      input_tokens: 912,
      cache_read_input_tokens: 200,
      output_tokens: 210,
    });
    assert.equal(result["model"], "grok-4.6");
    assert.equal(result["estimatedCostUsd"], null);
    assert.equal(
      priceText(result["costUsd"], result["estimatedCostUsd"]),
      "Price not known",
    );
  }));

await test("CLV-213 completion requires exit zero and an explicitly successful terminal result", async () => {
  for (const options of [
    { exitCode: 1 },
    { result: { ...grokResult, is_error: true } },
    { result: { ...grokResult, subtype: "error_max_turns" } },
    { result: { ...grokResult, is_error: undefined } },
    { result: { ...grokResult, subtype: undefined } },
    { events: grokMessages },
    { events: [] },
  ])
    await withScene(async (scene) => {
      const { report } = await grokTurn(scene, options);
      assert.equal(report?.outcome, "failed");
    });
});

await test("CLV-213 missing, zero or incomplete usage is unknown even with a known price", async () => {
  for (const options of [
    { result: { ...grokResult, usage: undefined } },
    {
      result: {
        ...grokResult,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    { stderr: incompleteWarning },
    {
      stderr:
        "WARN streaming-messages-json: no aggregate usage ledger at turn end; `result.usage` token counts fall back to zero (the Messages API schema has no absent-usage marker)",
    },
  ])
    await withScene(async (scene) => {
      const { result } = await grokTurn(scene, {
        result: { ...grokResult, modelUsage: { "grok-4.6": grokModelUsage } },
        ...options,
        settings: {
          tokenPrices: {
            "grok-4.6": { input: 2, cachedInput: 0.5, output: 8 },
          },
        },
      });
      assert.deepEqual(result["usage"], {
        input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens: null,
      });
      assert.equal(result["estimatedCostUsd"], null);
      assert.match(usageText(result["usage"]), /Token usage not known/);
    });
});

await test("CLV-213 the worker strips every GitHub token and supplies an empty configuration", () =>
  withScene(async (scene) => {
    const { observed } = await grokTurn(scene, {
      environment: {
        GH_TOKEN: "fake",
        GITHUB_TOKEN: "fake",
        GH_ENTERPRISE_TOKEN: "fake",
        GITHUB_ENTERPRISE_TOKEN: "fake",
        GH_CONFIG_DIR: "unused",
      },
    });
    assert.deepEqual(observed["tokens"], []);
    assert.deepEqual(observed["configuration"], []);
  }));

await test("CLV-213 mixed models retain totals but never estimate from the current model", () =>
  withScene(async (scene) => {
    const { result } = await grokTurn(scene, {
      result: {
        ...grokResult,
        modelUsage: { "grok-4.6": grokModelUsage, subagent: grokModelUsage },
      },
      settings: {
        tokenPrices: { "grok-4.6": { input: 2, cachedInput: 0.5, output: 8 } },
      },
    });
    assert.deepEqual(result["usage"], {
      input_tokens: 912,
      cache_read_input_tokens: 200,
      output_tokens: 210,
    });
    assert.equal(result["estimatedCostUsd"], null);
  }));

await test("CLV-213 one fully attributed priced model estimates cache writes and reads exactly", () =>
  withScene(async (scene) => {
    const { result } = await grokTurn(scene, {
      result: { ...grokResult, modelUsage: { "grok-priced": grokModelUsage } },
      settings: {
        tokenPrices: {
          "grok-priced": { input: 2, cachedInput: 0.5, output: 8 },
        },
      },
    });
    assert.equal(result["model"], "grok-priced");
    assert.equal(
      result["estimatedCostUsd"],
      (912 / 1_000_000) * 2 + (200 / 1_000_000) * 0.5 + (210 / 1_000_000) * 8,
    );
  }));

await test("CLV-213 partial model attribution and incomplete buckets cannot produce an estimate", async () => {
  for (const result of [
    {
      ...grokResult,
      modelUsage: { "grok-4.6": { ...grokModelUsage, inputTokens: 1 } },
    },
    { ...grokResult, modelUsage: { "grok-4.6": {} } },
    { ...grokResult, usage: { ...grokUsage, output_tokens: null } },
  ])
    await withScene(async (scene) => {
      const turn = await grokTurn(scene, {
        result,
        settings: {
          tokenPrices: {
            "grok-4.6": { input: 2, cachedInput: 0.5, output: 8 },
          },
        },
      });
      assert.equal(turn.result["estimatedCostUsd"], null);
    });
});

await test("CLV-213 the documented stderr warning invalidates nonzero usage", () =>
  withScene(async (scene) => {
    const { result } = await grokTurn(scene, { stderr: incompleteWarning });
    assert.match(usageText(result["usage"]), /Token usage not known/);
    assert.equal(result["estimatedCostUsd"], null);
  }));

await test("CLV-213 capacity failures never retry grok", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const { report } = await grokTurn(scene, {
      result: {
        ...grokResult,
        is_error: true,
        result: "Selected model is at capacity. Please try a different model.",
      },
      settings: {
        retryDelay: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      },
    });
    assert.equal(report?.outcome, "failed");
    assert.deepEqual(waits, []);
  }));

await test("CLV-213 a reported cost cannot bypass complete usage and known model pricing", () =>
  withScene(async (scene) => {
    const { result } = await grokTurn(scene, {
      result: { ...grokResult, total_cost_usd: 0.0127 },
    });
    assert.equal(result["costUsd"], null);
    assert.equal(
      priceText(result["costUsd"], result["estimatedCostUsd"]),
      "Price not known",
    );
  }));

await test("CLV-213 grok receives the prompt once and keeps profile options outside the prompt argument", () =>
  withScene(async (scene) => {
    const prompt = 'Do "one"\nturn';
    const { observed } = await grokTurn(scene, {
      prompt,
      settings: { profiles: { grok: { model: "selected-model" } } },
    });
    assert.equal(observed["stdin"], "");
    assert.deepEqual(observed["arguments"], [
      "--output-format",
      "streaming-messages-json",
      "--always-approve",
      "-p",
      prompt,
      "--model",
      "selected-model",
    ]);
  }));

await test("CLV-213 command overrides support the long prompt flag and a positional prompt", async () => {
  for (const fixed of [["--single"], []])
    await withScene(async (scene) => {
      const { observed } = await grokTurn(scene, {
        prompt: "one prompt",
        settings: {
          workerCommands: { grok: [join(scene.directory, "grok"), ...fixed] },
        },
      });
      assert.deepEqual(observed["arguments"], [...fixed, "one prompt"]);
      assert.equal(observed["stdin"], "");
    });
});
