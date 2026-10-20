import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { candidate } from "./chats-analysis-fixture.ts";
import { commandModel } from "../src/token-prices.ts";
import { analysisCommand } from "../src/daemon/analysis-launch.ts";
import {
  batchSnapshot,
  firstAnalysisBatch,
} from "./chats-analysis-batch-fixture.ts";
import { importId, corpus, manifest, sidecar } from "./chats-worker-fixture.ts";
import {
  alive,
  field,
  installAnalysisCli,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const operation = intent({
  method: "run-turn:analyze-chats",
  target: importId,
});
const snapshot = {
  importId,
  corpus,
  redaction: JSON.stringify(manifest),
  structure: JSON.stringify(sidecar),
};

for (const mode of ["capacity-once", "capacity-always"] as const) {
  await test(`CLV-119 ${mode} keeps every analysis launch at the checked byte boundary`, () =>
    withScene(async (scene) => {
      const evidence = batchSnapshot(["synthetic"]);
      const remaining = 65_536 - firstAnalysisBatch(evidence).launchBytes;
      evidence.redaction += " ".repeat(remaining);
      assert.ok(
        Buffer.byteLength(JSON.stringify({ snapshot: evidence })) <= 65_536,
      );
      const restore = installAnalysisCli(scene, { reply: "{}", mode });
      try {
        const worker = scene.worker("unused", {
          workflowId: () => Promise.resolve("analyze-chats"),
          document: () =>
            Promise.resolve(JSON.stringify({ snapshot: evidence })),
          retryDelay: () => Promise.resolve(),
        });
        const delivered = await worker.deliver(operation, signal);
        assert.ok("receipt" in delivered, JSON.stringify(delivered));
        await until(() => scene.reports.length === 1);
        const turns = scene.turns();
        assert.equal(turns.length, mode === "capacity-once" ? 2 : 3);
        for (const turn of turns) {
          const instruction =
            turn.arguments[turn.arguments.indexOf("--system-prompt") + 1];
          assert.ok(instruction);
          assert.equal(
            Buffer.byteLength(instruction) + Buffer.byteLength(turn.prompt),
            65_536,
          );
          assert.equal(turn.prompt, firstAnalysisBatch(evidence).prompt);
          assert.deepEqual(
            JSON.parse(turn.prompt),
            JSON.parse(firstAnalysisBatch(evidence).prompt),
          );
        }
      } finally {
        restore();
      }
    }));
}

await test("CLV-139 analysis retains its fixed model across all capacity retries despite configured fallbacks", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, {
      reply: "",
      mode: "capacity-always",
    });
    try {
      const worker = scene.worker("unused", {
        workflowId: () => Promise.resolve("analyze-chats"),
        document: () => Promise.resolve(JSON.stringify({ snapshot })),
        fallbackModels: ["unused-fallback"],
        retryDelay: () => Promise.resolve(),
      });
      await worker.deliver(operation, signal);
      await until(() => scene.reports.length === 1);
      const model = commandModel(analysisCommand());
      assert.equal(scene.turns().length, 3);
      for (const turn of scene.turns())
        assert.equal(commandModel(["claude", ...turn.arguments]), model);
      for (const attempt of [1, 2, 3])
        assert.equal(
          field(
            record(scene, `operation-1/attempt-${String(attempt)}.json`),
            "model",
          ),
          model,
        );
      const result = resultOf(scene.reports[0]?.result);
      assert.deepEqual(
        result["attempts"],
        [1, 2, 3].map((attempt) => ({
          attempt,
          model,
          usage: {
            input_tokens: 1500,
            cache_read_input_tokens: 800,
            output_tokens: 150,
          },
          costUsd: 0.25,
          estimatedCostUsd: null,
        })),
      );
      assert.equal(scene.reports[0]?.outcome, "failed");
    } finally {
      restore();
    }
  }));

await test("CLV-127 analysis uses the same capacity retries and usage totals", () =>
  withScene(async (scene) => {
    const reply = JSON.stringify(candidate());
    const restore = installAnalysisCli(scene, { reply, mode: "capacity-once" });
    try {
      const waits: number[] = [];
      const worker = scene.worker("unused", {
        workflowId: () => Promise.resolve("analyze-chats"),
        document: () => Promise.resolve(JSON.stringify({ snapshot })),
        retryDelay: (milliseconds, waiting) => {
          waits.push(milliseconds);
          return delay(0, undefined, { signal: waiting });
        },
      });
      await worker.deliver(operation, signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.deepEqual(waits, [60_000]);
      assert.equal(scene.turns().length, 2);
      const [first, second] = scene.turns();
      assert.ok(first);
      assert.ok(second);
      assert.equal(second.directory, first.directory);
      assert.deepEqual(second.environment, first.environment);
      assert.equal(second.prompt, first.prompt);
      const result = resultOf(scene.reports[0].result);
      assert.equal(result["reply"], reply);
      assert.equal(result["costUsd"], 0.5);
      assert.deepEqual(result["usage"], {
        input_tokens: 3000,
        cache_read_input_tokens: 1600,
        output_tokens: 300,
      });
    } finally {
      restore();
    }
  }));

await test("CLV-127 stopping a running analysis retry reports stopped", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, {
      reply: "",
      mode: "capacity-hold",
    });
    try {
      const worker = scene.worker("unused", {
        workflowId: () => Promise.resolve("analyze-chats"),
        document: () => Promise.resolve(JSON.stringify({ snapshot })),
        retryDelay: (_, stopping) => delay(0, undefined, { signal: stopping }),
      });
      await worker.deliver(operation, signal);
      await until(() => scene.turns().length === 2);
      const retry = scene.turns()[1];
      assert.ok(retry);
      assert.equal(alive(retry.processId), true);
      assert.equal((await worker.stop(operation, signal)).kind, "stopped");
      assert.equal(scene.reports.length, 1);
      assert.equal(scene.reports[0]?.outcome, "stopped");
      assert.equal(alive(retry.processId), false);
      assert.equal(scene.turns().length, 2);
      assert.equal(
        typeof field(record(scene, "operation-1/attempt-2.json"), "endedAt"),
        "string",
      );
    } finally {
      restore();
    }
  }));

await test("CLV-127 analysis stop during a capacity wait is stopped", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, {
      reply: "",
      mode: "capacity-always",
    });
    try {
      let waiting = false;
      const worker = scene.worker("unused", {
        workflowId: () => Promise.resolve("analyze-chats"),
        document: () => Promise.resolve(JSON.stringify({ snapshot })),
        retryDelay: (milliseconds, stopping) => {
          waiting = true;
          return delay(milliseconds, undefined, { signal: stopping });
        },
      });
      await worker.deliver(operation, signal);
      await until(() => waiting || scene.reports.length > 0);
      assert.equal(waiting, true);
      assert.equal((await worker.stop(operation, signal)).kind, "stopped");
      assert.equal(scene.reports[0]?.outcome, "stopped");
      assert.equal(scene.turns().length, 1);
    } finally {
      restore();
    }
  }));
