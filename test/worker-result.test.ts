import assert from "node:assert/strict";
import { test } from "node:test";
import { streamResult } from "../src/daemon/claude-turn.ts";
import {
  field,
  intent,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const usage = {
  input_tokens: 300,
  cache_read_input_tokens: 100,
  output_tokens: 20,
};
const unknownUsage = {
  input_tokens: null,
  cache_read_input_tokens: null,
  output_tokens: null,
};

await test("CLV-094 shared result readers preserve selected usage on success and error", () => {
  for (const is_error of [false, true]) {
    const result = streamResult(
      JSON.stringify({ type: "result", is_error, usage, total_cost_usd: 0 }),
    );
    assert.ok(result);
    assert.deepEqual(result.usage, usage);
    assert.equal(result.failed, is_error);
    assert.equal(result.costUsd, 0);
  }
  assert.equal(
    streamResult(JSON.stringify({ type: "assistant", usage })),
    undefined,
  );
  for (const value of [undefined, null, {}, [], "text"])
    assert.deepEqual(
      streamResult(JSON.stringify({ type: "result", usage: value }))?.usage,
      unknownUsage,
    );
});

await test("CLV-094 invalid usage and prices normalize while valid fields and zeros survive", () => {
  for (const value of [
    undefined,
    null,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "3",
  ]) {
    const result = streamResult(
      JSON.stringify({
        type: "result",
        usage: { ...usage, input_tokens: value },
      }),
    );
    assert.deepEqual(result?.usage, { ...usage, input_tokens: null });
  }
  for (const value of [undefined, null, -1, "3", Infinity, NaN])
    assert.equal(
      streamResult(JSON.stringify({ type: "result", total_cost_usd: value }))
        ?.costUsd,
      null,
    );
  assert.equal(
    streamResult('{"type":"result","total_cost_usd":1e400}')?.costUsd,
    null,
  );
  for (const value of [0, 0.25, 10])
    assert.equal(
      streamResult(JSON.stringify({ type: "result", total_cost_usd: value }))
        ?.costUsd,
      value,
    );
  assert.deepEqual(
    streamResult(
      '{"type":"result","usage":{"input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}',
    )?.usage,
    { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  );
});

await test("CLV-094 command wrappers store only the last result usage and price, including errors and reconciliation", () =>
  withScene(async (scene) => {
    for (const [index, is_error] of [false, true].entries()) {
      const lines = [
        {
          type: "result",
          usage: { ...usage, input_tokens: 9999 },
          total_cost_usd: 9,
        },
        { type: "assistant", usage },
        { type: "result", is_error, usage, total_cost_usd: 0.5 },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n");
      const command = [
        process.execPath,
        "-e",
        `process.stdin.resume();process.stdout.write(${JSON.stringify(lines)})`,
      ];
      const worker = scene.worker("unused", { command });
      const operation = intent({
        operationId: `wrapper-${String(index)}`,
        target: `ticket/wrapper-${String(index)}`,
      });
      await worker.deliver(operation, new AbortController().signal);
      await until(() => scene.reports.length === index + 1);
      const report = scene.reports[index];
      assert.equal(report?.outcome, is_error ? "failed" : "completed");
      const result = resultOf(report.result);
      assert.deepEqual(result["usage"], usage);
      assert.equal(result["costUsd"], 0.5);
      const reopened = scene.worker("hold");
      const reconciled = await reopened.reconcile(
        operation,
        new AbortController().signal,
      );
      assert.equal(field(reconciled, "result"), report.result);
    }
  }));
