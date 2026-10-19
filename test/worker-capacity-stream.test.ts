import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { capacityRefusal, startTurn } from "../src/daemon/claude-turn.ts";
import { intent, resultOf, until, withScene } from "./claude-worker-fixture.ts";

const overload = {
  type: "assistant",
  error: "overloaded",
  parent_tool_use_id: null,
};

const result = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
};
const cases = [
  { events: [overload, result], capacity: true },
  { events: [overload, { ...result, subtype: "success" }], capacity: true },
  {
    events: [overload, { ...result, subtype: "error_max_budget_usd" }],
    capacity: false,
  },
  {
    events: [overload, { ...result, subtype: "error_max_turns" }],
    capacity: false,
  },
  {
    events: [
      overload,
      { ...result, subtype: "error_max_structured_output_retries" },
    ],
    capacity: false,
  },
  {
    events: [overload, { ...result, error: "rate_limit" }],
    capacity: false,
  },
  {
    events: [overload, { type: "assistant", parent_tool_use_id: null }, result],
    capacity: false,
  },
  {
    events: [{ ...overload, parent_tool_use_id: "child" }, result],
    capacity: false,
  },
  { events: [overload, { ...result, is_error: false }], capacity: false },
  { events: [overload], capacity: false },
];

await test("CLV-127 only a terminal parent overload can authorize a stream retry", () =>
  withScene(async (scene) => {
    for (const [index, scenario] of cases.entries()) {
      const folder = join(scene.directory, `stream-${String(index)}`);
      mkdirSync(folder);
      const output = scenario.events
        .map((event) => JSON.stringify(event))
        .join("\n");
      const turn = startTurn({
        command: [
          process.execPath,
          "-e",
          `process.stdin.resume();process.stdout.write(${JSON.stringify(output)});`,
        ],
        directory: scene.repository,
        folder,
        prompt: "private prompt",
      });
      assert.equal(
        capacityRefusal((await turn.ended).result),
        scenario.capacity,
        JSON.stringify(scenario.events),
      );
    }
  }));

const codex = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const repeated = existsSync("partial.txt");
writeFileSync("partial.txt", prompt);
appendFileSync(process.argv[1], JSON.stringify({ prompt, directory: process.cwd() }) + "\\n");
const print = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
print({ type: "thread.started", thread_id: "thread-1" });
print({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } });
if (repeated) print({ type: "item.completed", item: { type: "agent_message", text: "Done" } });
else print({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } });
`;

await test("CLV-127 raw Codex capacity then success retains the tree and sums usage", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("unused", {
      worker: "codex",
      command: [
        process.execPath,
        "--input-type=module",
        "-e",
        codex,
        join(scene.directory, "turns.log"),
      ],
      retryDelay: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 2);
    assert.equal(scene.turns()[1]?.directory, scene.turns()[0]?.directory);
    assert.deepEqual(waits, [60_000]);
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["costUsd"], null);
    assert.deepEqual(result["usage"], {
      input_tokens: 200,
      cache_read_input_tokens: 80,
      output_tokens: 40,
    });
  }));
