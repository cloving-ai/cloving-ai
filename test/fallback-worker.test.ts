import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TurnSettings } from "../src/project-settings.ts";
import { commandModel } from "../src/token-prices.ts";
import {
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { fallbackCommand } from "./fallback-worker-fixture.ts";

await test("CLV-139 two capacity refusals use main, main, fallback and complete one operation", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("unused", {
      worker: "codex",
      command: fallbackCommand(scene),
      fallbackModels: ["gpt-6-astra", "unused-second", "unused-third"],
      retryDelay: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const models = ["gpt-6.1-sol", "gpt-6.1-sol", "gpt-6-astra"];
    assert.deepEqual(
      scene.turns().map((turn) => commandModel(["worker", ...turn.arguments])),
      models,
    );
    assert.deepEqual(waits, [60_000, 180_000]);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.reports.length, 1);
    for (const [index, model] of models.entries())
      assert.equal(
        field(
          record(scene, `operation-1/attempt-${String(index + 1)}.json`),
          "model",
        ),
        model,
      );
    await worker.deliver(intent(), new AbortController().signal);
    assert.equal(scene.turns().length, 3);
    assert.equal(scene.reports.length, 1);
  }));

await test("CLV-139 a missing model argument retains the command and records why fallback is unavailable", () =>
  withScene(async (scene) => {
    const command = fallbackCommand(scene).slice(0, -2);
    const worker = scene.worker("unused", {
      worker: "codex",
      command,
      fallbackModels: ["gpt-6-astra"],
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.turns().length, 3);
    assert.ok(scene.turns().every((turn) => turn.arguments.length === 0));
    const last = record(scene, "operation-1/attempt-3.json");
    assert.equal(field(last, "fallbackReason"), "fallback-model-unavailable");
    assert.equal(field(last, "model"), null);
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

await test("CLV-139 other failures never retry or select a fallback", () =>
  withScene(async (scene) => {
    let waits = 0;
    const worker = scene.worker("error-result", {
      fallbackModels: ["gpt-6-astra"],
      retryDelay: () => {
        waits += 1;
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.turns().length, 1);
    assert.equal(waits, 0);
  }));

await test("CLV-139 no fallback setting retains the main model for every capacity retry", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      worker: "codex",
      command: fallbackCommand(scene),
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene.turns().map((turn) => commandModel(["worker", ...turn.arguments])),
      Array<string>(3).fill("gpt-6.1-sol"),
    );
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

const directoryWorker = `
import { appendFileSync, readFileSync } from "node:fs";
const [log, ...argumentsList] = process.argv.slice(2);
const earlier = readFileSync(log, "utf8").split("\\n").filter((line) => line !== "" && JSON.parse(line).directory === process.cwd());
const attempt = earlier.length + 1;
for await (const chunk of process.stdin) void chunk;
appendFileSync(log, JSON.stringify({ prompt: "", arguments: argumentsList, directory: process.cwd() }) + "\\n");
const print = (event) => console.log(JSON.stringify(event));
print({ type: "thread.started", thread_id: "thread-" + attempt });
print({ type: "turn.completed", usage: { input_tokens: attempt * 1000000, cached_input_tokens: 0, output_tokens: 0 } });
if (attempt < 3) print({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } });
else print({ type: "item.completed", item: { type: "agent_message", text: "Done" } });
`;

function priced(model: string, input: number): TurnSettings {
  const price = { input, cachedInput: 0, output: 0 };
  return {
    profiles: {},
    fallbackModels: [model],
    tokenPrices: { "gpt-6.1-sol": price, [model]: price },
  };
}

await test("CLV-253 a turn keeps the fallback models and prices that it read at its start, and the next turn reads the new ones", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "directory-worker.mjs");
    writeFileSync(script, directoryWorker);
    let current = priced("start-fallback", 1);
    const worker = scene.worker("unused", {
      worker: "codex",
      command: [
        process.execPath,
        script,
        join(scene.directory, "turns.log"),
        "-m",
        "gpt-6.1-sol",
      ],
      turnSettings: () => current,
      retryDelay: () => {
        current = priced("new-fallback", 2);
        return Promise.resolve();
      },
    });
    const signal = new AbortController().signal;
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    await worker.deliver(
      intent({ operationId: "operation-2", target: "ticket/two" }),
      signal,
    );
    await until(() => scene.reports.length === 2);
    assert.deepEqual(
      scene.turns().map((turn) => commandModel(["worker", ...turn.arguments])),
      [
        "gpt-6.1-sol",
        "gpt-6.1-sol",
        "start-fallback",
        "gpt-6.1-sol",
        "gpt-6.1-sol",
        "new-fallback",
      ],
    );
    assert.deepEqual(
      scene.reports.map(
        (report) => resultOf(report.result)["estimatedCostUsd"],
      ),
      [6, 12],
    );
  }));
