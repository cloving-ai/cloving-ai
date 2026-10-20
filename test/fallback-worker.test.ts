import assert from "node:assert/strict";
import { test } from "node:test";
import { commandModel } from "../src/token-prices.ts";
import {
  field,
  intent,
  record,
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
