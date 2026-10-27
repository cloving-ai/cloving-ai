import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  intent,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import {
  chunkStream,
  fakeGemini,
  geminiReport,
  modelStream,
  modelUsage,
} from "./gemini-fixture.ts";
import { rendered } from "../src/cli/render.ts";
import { geminiStream } from "../src/daemon/gemini-stream.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";
import { activityOf } from "../src/cli/watch-model.ts";

for (const scenario of [
  {
    name: "object",
    parameters: { file_path: "HELLO.md" },
    input: { file_path: "HELLO.md" },
  },
  { name: "missing", parameters: undefined, input: {} },
  { name: "null", parameters: null, input: {} },
  { name: "array", parameters: ["HELLO.md"], input: {} },
  { name: "string", parameters: "HELLO.md", input: {} },
  { name: "number", parameters: 1, input: {} },
  { name: "boolean", parameters: true, input: {} },
])
  await test(`CLV-211 Gemini validates ${scenario.name} tool parameters before logging activity`, () => {
    const stream = geminiStream();
    const lines = stream.line(
      JSON.stringify({
        type: "tool_use",
        tool_name: "write_file",
        parameters: scenario.parameters,
      }),
    );
    assert.deepEqual(lines, [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "write_file", input: scenario.input },
          ],
        },
      }),
    ]);
  });

await test("CLV-211 Gemini ignores stream noise and warnings and keeps the last complete message", () => {
  const stream = geminiStream();
  for (const line of ["not JSON", "null", "[]"]) stream.line(line);
  for (const event of [
    { type: "init" },
    { type: "error", severity: "warning", message: "Temporary warning" },
    { type: "message", role: "assistant", content: "Earlier message" },
    { type: "message", role: "assistant", content: "Final message" },
    {
      type: "result",
      status: "success",
      stats: { input_tokens: 20, cached: 5, output_tokens: 3 },
    },
  ])
    stream.line(JSON.stringify(event));
  const result = streamResult(stream.result(0));
  assert.ok(result);
  assert.equal(result.failed, false);
  assert.equal(result.text, "Final message");
  assert.equal(result.model, null);
  assert.equal(result.sessionId, null);
  assert.equal(result.models, undefined);
  assert.deepEqual(result.usage, {
    input_tokens: 20,
    cache_read_input_tokens: 5,
    output_tokens: 3,
  });
});

for (const scenario of [
  {
    event: { type: "error", severity: "error" },
    expected: "Gemini error",
  },
  {
    event: { type: "result", status: "error" },
    expected: "Gemini result was not successful",
  },
])
  await test(`CLV-211 Gemini retains a missing error message as ${scenario.expected}`, () => {
    const stream = geminiStream();
    stream.line(JSON.stringify(scenario.event));
    const result = streamResult(stream.result(0));
    assert.ok(result);
    assert.equal(result.failed, true);
    assert.equal(result.text, scenario.expected);
  });

await test("CLV-211 Gemini prices each model separately and discounts inclusive cache once", () =>
  withScene(async (scene) => {
    const worker = scene.worker("bare", {
      harness: {
        name: "gemini",
        path: fakeGemini(scene, { events: modelStream }),
      },
      tokenPrices: {
        "gemini-test-pro": { input: 2, cachedInput: 0.5, output: 8 },
        "gemini-test-flash": { input: 1, cachedInput: 0.25, output: 4 },
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = resultOf(scene.reports[0]?.result);
    assert.ok(Math.abs(Number(report["estimatedCostUsd"]) - 2.825) < 1e-12);
    assert.equal(report["costUsd"], null);
  }));

for (const scenario of [
  {
    name: "a model price is missing",
    events: modelStream,
    usage: /Input tokens: 1500000/,
  },
  {
    name: "token counts are absent",
    events: chunkStream,
    usage: /Token usage not known/,
  },
])
  await test(`CLV-211 Gemini status is explicit when ${scenario.name}`, () =>
    withScene(async (scene) => {
      const worker = scene.worker("bare", {
        harness: { name: "gemini", path: fakeGemini(scene, scenario) },
        tokenPrices: {
          "gemini-test-pro": { input: 2, cachedInput: 0.5, output: 8 },
        },
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      const report = resultOf(scene.reports[0]?.result);
      assert.equal(report["estimatedCostUsd"], null);
      const text = rendered({
        kind: "run-status",
        run: { ...report, workerTurns: [{ ...report, operationId: "op" }] },
      });
      assert.match(text, /Price not known/);
      assert.match(text, scenario.usage);
    }));

await test("CLV-211 Gemini retains usage of each model and totals it once", () =>
  withScene(async (scene) => {
    const worker = scene.worker("bare", {
      harness: {
        name: "gemini",
        path: fakeGemini(scene, { events: modelStream }),
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = resultOf(scene.reports[0]?.result);
    assert.deepEqual(report["usage"], {
      input_tokens: 1_500_000,
      cache_read_input_tokens: 500_000,
      output_tokens: 150_000,
    });
    const attempts = report["attempts"];
    assert.ok(Array.isArray(attempts));
    assert.deepEqual(Reflect.get(Object(attempts[0]), "models"), modelUsage);
  }));

for (const failure of [
  { name: "no result", events: chunkStream.slice(0, -1), expected: /result/ },
  {
    name: "error result",
    events: [
      { type: "result", status: "error", error: { message: "API failure" } },
    ],
    expected: /API failure/,
  },
  {
    name: "error before success",
    events: [
      { type: "error", severity: "error", message: "Capacity unavailable" },
      ...chunkStream,
    ],
    expected: /Capacity unavailable/,
  },
  {
    name: "error after success",
    events: [
      ...chunkStream,
      { type: "error", severity: "error", message: "Late error" },
    ],
    expected: /Late error/,
  },
  {
    name: "nonzero exit",
    events: [
      { type: "result", status: "error", error: { message: "Command failed" } },
    ],
    exitCode: 1,
    expected: /Command failed/,
  },
  {
    name: "nonzero exit after success",
    events: chunkStream,
    exitCode: 1,
    expected: /gemini ended with code 1/,
  },
])
  await test(`CLV-211 Gemini fails for ${failure.name}`, () =>
    withScene(async (scene) => {
      const worker = scene.worker("bare", {
        harness: { name: "gemini", path: fakeGemini(scene, failure) },
        retryDelay: () => {
          throw new Error("Gemini must not retry");
        },
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "failed");
      assert.match(
        String(resultOf(scene.reports[0].result)["summary"]),
        failure.expected,
      );
    }));

await test("CLV-211 a Gemini default joins the last assistant chunks and commits in the worktree", () =>
  withScene(async (scene) => {
    const program = fakeGemini(scene);
    const worker = scene.worker("bare", {
      harness: { name: "gemini", path: program },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const report = resultOf(scene.reports[0].result);
    assert.equal(report["summary"], geminiReport);
    assert.equal(report["harness"], "gemini");
    assert.equal(report["model"], "gemini-test-pro");
    assert.deepEqual(report["ticketStatus"], { kind: "complete" });
    const lines = readFileSync(
      join(scene.journal, journalKey("operation-1"), "turn.jsonl"),
      "utf8",
    ).split("\n");
    assert.deepEqual(
      lines.flatMap(activityOf).filter((item) => item.kind === "tool"),
      [{ kind: "tool", text: "write_file: HELLO.md" }],
    );
    const observed = resultOf(
      readFileSync(join(scene.directory, "gemini-observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], [
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
      "-p",
      "prompt of sha256:prompt",
    ]);
    assert.equal(observed["stdin"], "");
    assert.equal(observed["directory"], report["worktree"]);
    assert.ok(
      Array.isArray(report["commits"]) && report["commits"].length === 1,
    );
  }));
