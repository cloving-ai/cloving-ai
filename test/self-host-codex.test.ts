import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeCodex } from "./codex-fixture.ts";
import {
  ended,
  field,
  items,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";
import { watchedModel } from "./watch-fixture.ts";

const usage = {
  input_tokens: 100,
  cache_read_input_tokens: 40,
  output_tokens: 20,
};

async function checkedWatchUsage(directory: string): Promise<void> {
  const model = await watchedModel(join(directory, "run"));
  const run = field(field(model, "runs"), 0);
  const turn = field(field(run, "turns"), 0);
  assert.deepEqual(
    [
      field(run, "claudeCostUsd"),
      field(turn, "costUsd"),
      field(turn, "outcome"),
    ],
    [null, null, "completed"],
  );
  assert.deepEqual(
    items(field(turn, "activity")).map((item) => field(item, "text")),
    [
      "Bash: git status",
      "Edit: codex-work.txt",
      "Working.",
      "Done.",
      "Result of the worker (cost ≈ 0.00 USD (estimate))",
    ],
  );
  assert.deepEqual(field(run, "usage"), usage);
  assert.deepEqual(field(turn, "usage"), usage);
  for (const value of [run, turn])
    assert.ok(
      Math.abs(Number(field(value, "estimatedCostUsd")) - 0.0003) < 1e-15,
    );
}

await test("CLV-083 start selects the Codex command for a develop-ticket worker and retains unknown cost", () =>
  withoutChildren(async () => {
    const { root, directory, runtimeDirectory, start } = await scene();
    const script = join(root, "fake-codex.mjs");
    writeFileSync(script, fakeCodex);
    const daemon = await start({
      CLOVING_WORKER: "codex",
      CLOVING_CLAUDE_COMMAND: "not JSON",
      CLOVING_CODEX_COMMAND: JSON.stringify([
        process.execPath,
        script,
        "--model",
        "configured",
      ]),
      CLOVING_TOKEN_PRICES: JSON.stringify({
        configured: { input: 2, cachedInput: 0.5, output: 8 },
      }),
    });
    const admitted = await call(
      { runtimeDirectory },
      {
        operation: "run",
        parameters: {
          workflowId: "develop-ticket",
          source: "ticket",
          submission: { ticket: "CLV-900" },
          commandId: "codex-1",
        },
      },
    );
    const runId = String(admitted["runId"]);
    const decision = await reached(
      async () =>
        items(
          (
            await call(
              { runtimeDirectory },
              { operation: "questions", parameters: { runId } },
            )
          )["decisions"],
        )[0],
    );
    assert.match(String(field(decision, "prompt")), /Done\./);
    await checkedWatchUsage(directory);
    assert.equal(await ended(daemon), 0);
  }));

await test("CLV-083 start refuses an unknown worker", () =>
  withoutChildren(async () => {
    const { refused } = await scene();
    assert.match(
      await refused("8", { CLOVING_WORKER: "other" }),
      /invalid-worker/,
    );
  }));
