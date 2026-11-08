import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const text = "Change only src/cli.ts.";

function steerNote(noteId: string) {
  return { runId: "run-1", noteId, text };
}

await test("CLV-327 a note sent now stops a turn with a recorded session and resumes the same session with the note as the next message", () =>
  withScene(async (scene) => {
    const worker = scene.worker("crash-once");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    assert.deepEqual(await worker.steer(steerNote("note-b")), {
      delivery: "now",
      operationId: "operation-1",
    });
    await until(() => scene.reports.length === 1);
    const [first, resumed, ...others] = scene.turns();
    assert.ok(first && resumed);
    assert.deepEqual(others, []);
    assert.equal(alive(first.processId), false);
    assert.equal(
      resumed.prompt,
      `A person sent this note while you worked:\n\n${text}`,
    );
    assert.deepEqual(
      resumed.arguments.slice(resumed.arguments.indexOf("--resume")),
      ["--resume", "session-1"],
    );
    assert.equal(resumed.directory, first.directory);
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "resumedAfter"),
      "steer",
    );
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "notes"),
      ["note-b"],
    );
    assert.equal(field(scene.reports[0], "outcome"), "completed");
    assert.equal(field(scene.reports[0], "operationId"), "operation-1");
  }));

await test("CLV-327 a note sent now waits for the next turn when the run has no open turn", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    assert.deepEqual(await worker.steer(steerNote("note-b")), {
      delivery: "queued",
      reason: "no-open-turn",
    });
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    assert.deepEqual(
      await worker.steer({ ...steerNote("note-c"), runId: "run-2" }),
      { delivery: "queued", reason: "no-open-turn" },
    );
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-327 a note sent now waits for the next turn when the open turn recorded no session, and the turn goes on", () =>
  withScene(async (scene) => {
    const worker = scene.worker("sessionless");
    await worker.deliver(intent(), signal);
    await until(() => scene.turns().length === 1);
    assert.deepEqual(await worker.steer(steerNote("note-b")), {
      delivery: "queued",
      reason: "no-session",
    });
    assert.equal(alive(scene.turns()[0]?.processId ?? 0), true);
    assert.equal(
      field(record(scene, "operation-1/started.json"), "notes"),
      undefined,
    );
  }));

await test("CLV-327 a note sent now waits for the next turn when the harness of the open turn cannot resume a session", () =>
  withScene(async (scene) => {
    const worker = scene.worker("codex-session", { worker: "codex" });
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "thread-1",
    );
    assert.deepEqual(await worker.steer(steerNote("note-b")), {
      delivery: "queued",
      reason: "harness-cannot-resume",
    });
    assert.equal(scene.turns().length, 1);
    assert.equal(alive(scene.turns()[0]?.processId ?? 0), true);
  }));

await test("CLV-327 a turn takes at most three notes sent now, and a fourth note waits for the next turn", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    for (const [index, noteId] of ["note-b", "note-c", "note-d"].entries()) {
      const attempt = `operation-1/attempt-${String(index + 1)}.json`;
      await until(
        () => field(record(scene, attempt), "sessionId") === "session-1",
      );
      assert.equal((await worker.steer(steerNote(noteId))).delivery, "now");
      await until(() => scene.turns().length === index + 2);
    }
    await until(
      () =>
        field(record(scene, "operation-1/attempt-4.json"), "sessionId") ===
        "session-1",
    );
    assert.deepEqual(await worker.steer(steerNote("note-e")), {
      delivery: "queued",
      reason: "note-limit",
    });
    assert.equal(scene.turns().length, 4);
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "notes"),
      ["note-b", "note-c", "note-d"],
    );
    assert.equal(
      field(record(scene, "operation-1/started.json"), "attempt"),
      4,
    );
  }));
