import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { activityOf } from "../src/cli/watch-model.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";
import {
  intent,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

import { fakeCodex } from "./codex-fixture.ts";

await test("CLV-083 the Codex worker records translated activity and a final result with no cost", () =>
  withScene(async (scene) => {
    const worker = scene.worker("complete", {
      worker: "codex",
      command: [process.execPath, "--input-type=module", "-e", fakeCodex],
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.deepEqual(
      [
        result["summary"],
        result["costUsd"],
        result["sessionId"],
        result["turns"],
      ],
      ["Done.", null, "thread-1", 1],
    );
    const output = readFileSync(
      join(scene.journal, journalKey("operation-1"), "turn.jsonl"),
      "utf8",
    );
    const lines = output.trim().split("\n");
    assert.equal(
      lines[0],
      '{"type":"system","subtype":"init","session_id":"thread-1"}',
    );
    assert.equal(lines.length, 6);
    assert.deepEqual(lines.flatMap(activityOf), [
      { kind: "tool", text: "Bash: git status" },
      { kind: "tool", text: "Edit: codex-work.txt" },
      { kind: "say", text: "Working." },
      { kind: "say", text: "Done." },
      { kind: "result", text: "Done." },
    ]);
    assert.deepEqual(streamResult(lines.at(-1) ?? ""), {
      text: "Done.",
      failed: false,
      costUsd: null,
      sessionId: "thread-1",
      turns: 1,
    });
    assert.equal(
      readFileSync(
        join(scene.worktrees, "ticket-one", "codex-work.txt"),
        "utf8",
      ),
      "prompt of sha256:prompt",
    );
  }));
