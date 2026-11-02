import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const heldCodex = `
import { appendFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync("codex-calls.jsonl", JSON.stringify(process.argv.slice(1)) + "\\n");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "thread.started", thread_id: "thread-7" });
const resumed = process.argv.includes("resume");
if (!resumed) setInterval(() => undefined, 1000);
if (resumed) line({ type: "item.completed", item: { type: "agent_message", text: "Resumed." } });
if (resumed) line({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
`;

const configured = ["exec", "--json", "-m", "model-one", "-"];

function codexOptions(parts: readonly string[] = configured) {
  return {
    worker: "codex",
    command: [
      process.execPath,
      "--input-type=module",
      "-e",
      heldCodex,
      ...parts,
    ],
  };
}

function calls(scene: Scene): readonly unknown[] {
  const path = join(scene.worktrees, "ticket-one", "codex-calls.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

async function interrupted(
  scene: Scene,
  parts: readonly string[] = configured,
): Promise<void> {
  const first = scene.worker("hold", codexOptions(parts));
  await first.deliver(intent(), new AbortController().signal);
  await until(
    () =>
      field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
      "thread-7",
  );
  await first.close();
  assert.equal(scene.reports.length, 0);
}

await test("CLV-269 a daemon restart resumes an open Codex turn in its recorded thread", () =>
  withScene(async (scene) => {
    await interrupted(scene);
    await scene.worker("hold", codexOptions()).recover(intent());
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(resultOf(scene.reports[0].result)["summary"], "Resumed.");
    assert.deepEqual(calls(scene), [
      configured,
      ["exec", "resume", "thread-7", "--json", "-m", "model-one", "-"],
    ]);
  }));

await test("CLV-269 an open Codex turn with no recorded thread cannot resume", () =>
  withScene(async (scene) => {
    await interrupted(scene);
    const path = join(
      scene.journal,
      journalKey("operation-1"),
      "attempt-1.json",
    );
    const saved = record(scene, "operation-1/attempt-1.json");
    writeFileSync(path, JSON.stringify({ ...Object(saved), sessionId: "" }));
    const reply = await scene
      .worker("hold", codexOptions())
      .reconcile(intent(), new AbortController().signal);
    assert.equal(field(reply, "reason"), "claude-turn-interrupted");
    assert.equal(calls(scene).length, 1);
  }));

await test("CLV-269 a Codex command with no exec element cannot resume", () =>
  withScene(async (scene) => {
    await interrupted(scene);
    const reply = await scene
      .worker("hold", codexOptions(["--json", "-"]))
      .reconcile(intent(), new AbortController().signal);
    assert.equal(field(reply, "reason"), "claude-turn-interrupted");
    assert.equal(calls(scene).length, 1);
  }));

await test("CLV-269 a Codex turn does not resume with the Claude harness", () =>
  withScene(async (scene) => {
    await interrupted(scene);
    const reply = await scene
      .worker("hold")
      .reconcile(intent(), new AbortController().signal);
    assert.equal(field(reply, "reason"), "claude-turn-interrupted");
    assert.equal(calls(scene).length, 1);
    assert.equal(scene.turns().length, 0);
  }));
