import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  receivedLines,
  streamState,
  type TurnProgress,
} from "../src/daemon/turn-stream.ts";
import {
  alive,
  field,
  intent,
  record,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const text = "Change only src/cli.ts.";
const later = "Keep the tests of src/cli.ts.";

function steerNote(noteId: string, note = text) {
  return { runId: "run-1", noteId, text: note };
}

function sessionAt(scene: Scene, attempt: number): Promise<void> {
  const name = `operation-1/attempt-${String(attempt)}.json`;
  const sessionId = `session-${String(attempt)}`;
  return until(() => field(record(scene, name), "sessionId") === sessionId);
}

function noted(prompt: string, texts: readonly string[]): string {
  const notes = texts.map(
    (note) => `\n\nA person sent this note while you worked:\n\n${note}`,
  );
  return `${prompt}${notes.join("")}`;
}

await test("#845 notes sent now before the first conversation message start the turn again with the task and each note once, and do not resume a session with no conversation", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hook-only");
    await worker.deliver(intent(), signal);
    await sessionAt(scene, 1);
    assert.deepEqual(await worker.steer(steerNote("note-b", text)), {
      delivery: "now",
      operationId: "operation-1",
    });
    await sessionAt(scene, 2);
    assert.equal(
      (await worker.steer(steerNote("note-c", later))).delivery,
      "now",
    );
    await until(() => scene.reports.length === 1);
    const [first, second, third, ...others] = scene.turns();
    assert.ok(first && second && third);
    assert.deepEqual(others, []);
    assert.equal(alive(first.processId), false);
    assert.equal(alive(second.processId), false);
    assert.equal(second.arguments.includes("--resume"), false);
    assert.equal(third.arguments.includes("--resume"), false);
    assert.equal(second.prompt, noted(first.prompt, [text]));
    assert.equal(third.prompt, noted(first.prompt, [text, later]));
    assert.equal(third.directory, first.directory);
    assert.equal(
      field(record(scene, "operation-1/attempt-3.json"), "resumedAfter"),
      "steer",
    );
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "notes"),
      ["note-b", "note-c"],
    );
    assert.equal(field(scene.reports[0], "outcome"), "completed");
    assert.match(String(field(scene.reports[0], "result")), /Ticket status/);
  }));

await test("#845 a batch of stream lines with the start event and the first conversation message gives one progress with the session and the conversation", async () => {
  const snapshots: TurnProgress[] = [];
  const stream = streamState();
  receivedLines(stream, {
    lines: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    ],
    progress: (progress) => {
      snapshots.push(progress);
      return Promise.resolve();
    },
    failed: () => undefined,
  });
  await stream.saved;
  assert.deepEqual(snapshots, [
    { sessionId: "s-1", conversation: true, result: undefined },
  ]);
});

await test("#845 a note sent now to a Codex turn with a thread and no message resumes the thread as before", () =>
  withScene(async (scene) => {
    const worker = scene.worker("codex-session", {
      worker: "codex",
      command: [
        ...["env", "-u", "NODE_V8_COVERAGE", process.execPath],
        ...[join(scene.directory, "fake-claude.mjs"), "codex-session"],
        ...[join(scene.directory, "turns.log"), "exec"],
      ],
    });
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "thread-1",
    );
    assert.equal((await worker.steer(steerNote("note-b"))).delivery, "now");
    await until(() => scene.turns().length === 2);
    const resumed = scene.turns()[1];
    assert.ok(resumed);
    assert.deepEqual(
      resumed.arguments.slice(resumed.arguments.indexOf("exec")),
      ["exec", "resume", "thread-1"],
    );
    assert.equal(
      resumed.prompt,
      `A person sent this note while you worked:\n\n${text}`,
    );
  }));

await test("#845 the README says that a note sent now before the first conversation message starts the turn again with a new session", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(
    readme.includes(
      "The worker stops the turn and starts it again with a new session. The prompt has the prompt of the stopped attempt and, after it, the note.",
    ),
  );
});
