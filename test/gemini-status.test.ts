import assert from "node:assert/strict";
import { test } from "node:test";
import { modelUsageOf, usageOf } from "../src/worker-usage.ts";
import { call, field, runCli, withHarness } from "./service-fixture.ts";
import { reportTurn, workerScene } from "./worker-report-fixture.ts";
import { intent, until, withScene } from "./claude-worker-fixture.ts";
import {
  fakeGemini,
  geminiReport,
  modelStream,
  modelUsage,
} from "./gemini-fixture.ts";

await test("CLV-211 status retains Gemini reports and model counts after restart", () =>
  withHarness(async (harness) => {
    const service = await workerScene(harness);
    await withScene(async (scene) => {
      const worker = scene.worker("bare", {
        harness: {
          name: "gemini",
          path: fakeGemini(scene, { events: modelStream }),
        },
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      const result = scene.reports[0]?.result;
      assert.ok(typeof result === "string");
      await reportTurn(service, { round: 1, result });
    });
    const verify = async () => {
      const status = await call(harness, {
        operation: "status",
        parameters: { runId: service.runId },
      });
      const turn = field(field(status["run"], "workerTurns"), "0");
      assert.equal(field(turn, "summary"), geminiReport);
      assert.equal(field(turn, "model"), "gemini-test-pro");
      assert.deepEqual(
        field(field(field(turn, "attempts"), "0"), "models"),
        modelUsage,
      );
      const text = await runCli(["status", service.runId], {
        directory: harness.projectDirectory,
        runtime: harness.runtimeDirectory,
      });
      assert.match(text.stdout, /Added HELLO.md/);
      assert.match(text.stdout, /Model: gemini-test-pro/);
      assert.match(text.stdout, /gemini-test-flash.*Input tokens: 500000/);
    };
    await verify();
    await service.service.close();
    const reopened = await harness.start(service.options);
    await verify();
    await reopened.close();
  }));

await test("CLV-211 model usage keeps only object entries with a model name", () => {
  const usage = { input_tokens: 3, output_tokens: 2 };
  assert.deepEqual(
    modelUsageOf([
      5,
      null,
      "gemini-test-pro",
      { usage },
      { model: "m", usage },
    ]),
    [{ model: "m", usage: usageOf(usage) }],
  );
  assert.equal(modelUsageOf({ model: "m" }), undefined);
});
