import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { usageText, priceText } from "../src/cli/usage-render.ts";
import {
  git,
  intent,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { cursorFixture, fakeCursor } from "./cursor-fixture.ts";

await test("CLV-214 Cursor records priced terminal usage and the last partial ticket report", () =>
  withScene(async (scene) => {
    const usage = {
      inputTokens: 1000000,
      cacheReadTokens: 400000,
      cacheWriteTokens: 0,
      outputTokens: 100000,
    };
    const report =
      "Implemented part.\nRemaining:\n- Finish the UI\nTicket status: partial";
    const output = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: report }] },
        usage: { inputTokens: 9 },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        model: "priced",
        usage,
        result: "All messages combined.",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const worker = scene.worker("unused", {
      harness: fakeCursor(scene, { output }),
      tokenPrices: { priced: { input: 2, cachedInput: 0.5, output: 8 } },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["summary"], report);
    assert.deepEqual(result["ticketStatus"], {
      kind: "partial",
      remaining: ["Finish the UI"],
    });
    assert.deepEqual(result["usage"], {
      input_tokens: 1000000,
      cache_read_input_tokens: 400000,
      cache_creation_input_tokens: 0,
      output_tokens: 100000,
    });
    assert.equal(result["estimatedCostUsd"], 3);
    assert.equal(result["costUsd"], null);
  }));

await test("CLV-214 Cursor gets an empty disposable GitHub configuration and no token variables", () =>
  withScene(async (scene) => {
    const names = [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ];
    const worker = scene.worker("unused", {
      harness: fakeCursor(scene, { output: cursorFixture("completed") }),
      profiles: {
        isolated: {
          env: {
            GH_TOKEN: "test-secret",
            GITHUB_TOKEN: "test-secret",
            GH_ENTERPRISE_TOKEN: "test-secret",
            GITHUB_ENTERPRISE_TOKEN: "test-secret",
            GH_CONFIG_DIR: scene.repository,
          },
        },
      },
    });
    await worker.deliver(
      intent({ method: "run-turn:isolated" }),
      new AbortController().signal,
    );
    await until(() => scene.reports.length === 1);
    const invocation = resultOf(
      readFileSync(join(scene.directory, "cursor-invocations.jsonl"), "utf8"),
    );
    assert.deepEqual(invocation["configuration"], []);
    const environment = invocation["environment"];
    assert.ok(typeof environment === "object" && environment !== null);
    for (const name of names)
      assert.equal(Reflect.get(environment, name), undefined);
    const folder: unknown = Reflect.get(environment, "GH_CONFIG_DIR");
    assert.equal(typeof folder, "string");
    assert.notEqual(folder, scene.repository);
    assert.equal(existsSync(String(folder)), false);
  }));

await test("CLV-214 Cursor capacity errors never wait, retry or select a fallback model", () =>
  withScene(async (scene) => {
    let waits = 0;
    const worker = scene.worker("unused", {
      harness: fakeCursor(scene, { output: cursorFixture("failed") }),
      fallbackModels: ["fallback"],
      retryDelay: () => {
        waits += 1;
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(waits, 0);
    assert.equal(
      readFileSync(join(scene.directory, "cursor-invocations.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
  }));

for (const scenario of [
  { fixture: "error", exitCode: 0, error: "Cursor request failed." },
  {
    fixture: "incomplete",
    exitCode: 0,
    error: "cursor-agent stream ended before its result",
  },
  {
    fixture: "failed",
    exitCode: 0,
    error: "Selected model is at capacity. Please try a different model.",
  },
  {
    fixture: "completed",
    exitCode: 1,
    error: "cursor-agent ended with the code 1",
  },
])
  await test(`CLV-214 Cursor ${scenario.fixture} with exit ${String(scenario.exitCode)} fails explicitly`, () =>
    withScene(async (scene) => {
      const worker = scene.worker("unused", {
        harness: fakeCursor(scene, {
          output: cursorFixture(scenario.fixture),
          exitCode: scenario.exitCode,
        }),
        retryDelay: () => Promise.resolve(),
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "failed");
      assert.equal(
        resultOf(scene.reports[0].result)["summary"],
        scenario.error,
      );
    }));

await test("CLV-214 the private Cursor default runs once in its work tree with a literal prompt and unknown usage", () =>
  withScene(async (scene) => {
    const prompt =
      "Implement \"quoted text\" and 'single quotes'.\nThen commit.";
    const worker = scene.worker("unused", {
      harness: fakeCursor(scene, { output: cursorFixture("completed") }),
      document: () => Promise.resolve(prompt),
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.equal(report?.outcome, "completed");
    const result = resultOf(report.result);
    assert.equal(result["harness"], "cursor-agent");
    assert.equal(
      result["summary"],
      "Implemented the change.\nTicket status: complete",
    );
    assert.deepEqual(result["ticketStatus"], { kind: "complete" });
    assert.equal(result["sessionId"], "cursor-session");
    assert.equal(result["model"], "Claude 4 Sonnet");
    assert.equal(result["estimatedCostUsd"], null);
    assert.match(usageText(result["usage"]), /Token usage not known/);
    assert.equal(
      priceText(result["costUsd"], result["estimatedCostUsd"]),
      "Price not known",
    );
    const invocations = readFileSync(
      join(scene.directory, "cursor-invocations.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    assert.equal(invocations.length, 1);
    const invocation = resultOf(invocations[0]);
    assert.deepEqual(invocation["arguments"], [
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      prompt,
    ]);
    assert.equal(invocation["directory"], result["worktree"]);
    assert.equal(
      git(String(result["worktree"]), ["log", "-1", "--format=%s"]),
      "Apply the change",
    );
  }));
