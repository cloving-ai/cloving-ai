import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { activityOf } from "../src/cli/watch-model.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";
import {
  intent,
  git,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

import { fakeCodex } from "./codex-fixture.ts";

await test("CLV-088 Codex uses the existing branch work tree and refuses another turn when it is dirty", () =>
  withScene(async (scene) => {
    const tree = join(scene.directory, "existing");
    git(scene.repository, ["worktree", "add", "-b", "feature-search", tree]);
    const worker = scene.worker("complete", {
      worker: "codex",
      command: [process.execPath, "--input-type=module", "-e", fakeCodex],
    });
    const target = "branch:feature-search";
    const signal = new AbortController().signal;
    await worker.deliver(intent({ target }), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.deepEqual(
      [result["worktree"], result["branch"]],
      [tree, "feature-search"],
    );
    assert.equal(
      readFileSync(join(tree, "codex-work.txt"), "utf8"),
      "prompt of sha256:prompt",
    );
    assert.deepEqual(
      await worker.deliver(
        intent({ target, operationId: "operation-2" }),
        signal,
      ),
      { kind: "failed", reason: "branch-worktree-not-clean" },
    );
    assert.equal(
      existsSync(join(scene.journal, journalKey("operation-2"))),
      false,
    );
    assert.equal(scene.reports.length, 1);
  }));

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

await test("CLV-087 the Codex worker completes a turn after a reconnect error", () =>
  withScene(async (scene) => {
    const events = [
      { type: "thread.started", thread_id: "reconnected-thread" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Working." },
      },
      { type: "error", message: "Reconnecting... 3/5" },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered." },
      },
      { type: "turn.completed" },
    ];
    const output = events.map((event) => JSON.stringify(event)).join("\n");
    const worker = scene.worker("complete", {
      worker: "codex",
      command: [
        process.execPath,
        "--input-type=module",
        "-e",
        `process.stdin.resume(); process.stdout.write(${JSON.stringify(output)});`,
      ],
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(resultOf(scene.reports[0].result)["summary"], "Recovered.");
    const lines = readFileSync(
      join(scene.journal, journalKey("operation-1"), "turn.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    assert.deepEqual(streamResult(lines.at(-1) ?? ""), {
      text: "Recovered.",
      failed: false,
      costUsd: null,
      sessionId: "reconnected-thread",
      turns: 1,
    });
    assert.deepEqual(lines.flatMap(activityOf), [
      { kind: "say", text: "Working." },
      { kind: "say", text: "Recovered." },
      { kind: "result", text: "Recovered." },
    ]);
  }));
