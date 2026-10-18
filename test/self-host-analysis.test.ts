import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidate } from "./chats-analysis-fixture.ts";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import { installAnalysisCli } from "./claude-worker-fixture.ts";
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

await test("CLV-116 a Codex daemon runs declared chat analysis with the restricted Claude CLI and keeps Codex for development", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const restore = installAnalysisCli(
      { directory: fixture.root },
      { reply: JSON.stringify(candidate()) },
    );
    const script = join(fixture.root, "codex.mjs");
    writeFileSync(script, fakeCodex);
    const evidence = join(fixture.runtimeDirectory, "chats", importId);
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    for (const [name, text] of [
      ["redaction.json", JSON.stringify(manifest)],
      ["redacted.jsonl", corpus],
      ["structure.json", JSON.stringify(sidecar)],
    ])
      writeFileSync(join(evidence, String(name)), String(text), {
        mode: 0o600,
      });
    try {
      const daemon = await fixture.start({
        CLOVING_SELF_UPDATE_SECONDS: undefined,
        CLOVING_WORKER: "codex",
        CLOVING_CLAUDE_COMMAND: "not JSON",
        CLOVING_CODEX_COMMAND: JSON.stringify([process.execPath, script]),
      });
      await assertAnalysis(fixture.runtimeDirectory, fixture.root);
      await assertDevelopment(fixture.runtimeDirectory);
      assert.equal(await ended(daemon), 0);
    } finally {
      restore();
    }
  }));

async function assertDevelopment(runtimeDirectory: string): Promise<void> {
  const admitted = await call(
    { runtimeDirectory },
    {
      operation: "run",
      parameters: {
        workflowId: "develop-ticket",
        source: "ticket",
        submission: { ticket: "CLV-900" },
        commandId: "development-daemon",
      },
    },
  );
  const decision = await reached(
    async () =>
      items(
        (
          await call(
            { runtimeDirectory },
            {
              operation: "questions",
              parameters: { runId: admitted["runId"] },
            },
          )
        )["decisions"],
      )[0],
  );
  assert.match(String(field(decision, "prompt")), /Done\./);
  const status = await call(
    { runtimeDirectory },
    { operation: "status", parameters: { runId: admitted["runId"] } },
  );
  assert.equal(field(status["run"], "claudeCostUsd"), null);
  assert.deepEqual(field(status["run"], "usage"), {
    input_tokens: 100,
    cache_read_input_tokens: 40,
    output_tokens: 20,
  });
}

async function assertAnalysis(
  runtimeDirectory: string,
  root: string,
): Promise<void> {
  const analysis = await call(
    { runtimeDirectory: runtimeDirectory },
    {
      operation: "run",
      parameters: {
        workflowId: "analyze-chats",
        source: "input",
        submission: { importId },
        commandId: "analysis-daemon",
      },
    },
  );
  const status = await reached(async () => {
    const result = await call(
      { runtimeDirectory: runtimeDirectory },
      { operation: "status", parameters: { runId: analysis["runId"] } },
    );
    return field(result["run"], "state") === "completed"
      ? result["run"]
      : undefined;
  });
  assert.deepEqual(field(status, "outcome"), {
    kind: "handoff_requested",
    reason: null,
  });
  assert.deepEqual(field(status, "budget"), { limit: 3, spent: 3 });
  assert.equal(items(field(status, "workerTurns")).length, 1);
  const turns = readFileSync(join(root, "turns.log"), "utf8")
    .trim()
    .split("\n");
  assert.equal(turns.length, 1);
  const turn: unknown = JSON.parse(String(turns[0]));
  assert.ok(items(field(turn, "arguments")).includes("--bare"));
  const model = await watchedModel(runtimeDirectory);
  assert.equal(
    JSON.stringify(model).includes("Bounded review and repair"),
    false,
  );
}
