import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attemptsOf } from "../src/worker-usage.ts";
import { readResume } from "../src/daemon/claude-recovery.ts";
import type { ClaudeWorker } from "../src/daemon/claude-worker.ts";
import { receivedNotes } from "../src/daemon/turn-notes.ts";
import {
  alive,
  field,
  intent,
  journalKey,
  record,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const text = "Change only src/cli.ts.";

function steerNote(noteId: string) {
  return { runId: "run-1", noteId, text };
}

function sessionAt(scene: Scene, attempt: number): Promise<void> {
  const name = `operation-1/attempt-${String(attempt)}.json`;
  return until(() => field(record(scene, name), "sessionId") === "session-1");
}

async function steeredThreeTimes(
  scene: Scene,
  worker: ClaudeWorker,
): Promise<void> {
  await worker.deliver(intent(), signal);
  for (const [index, noteId] of ["note-b", "note-c", "note-d"].entries()) {
    await sessionAt(scene, index + 1);
    assert.equal((await worker.steer(steerNote(noteId))).delivery, "now");
    await until(() => scene.turns().length === index + 2);
  }
  await sessionAt(scene, 4);
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
    await steeredThreeTimes(scene, worker);
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

await test("CLV-327 a note sent now counts as received only after the resumed agent starts, and a restart before that start resumes the earlier attempt", () =>
  withScene(async (scene) => {
    const folder = join(scene.journal, journalKey("operation-1"));
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await sessionAt(scene, 1);
    writeFileSync(join(folder, "attempt-2"), "");
    assert.equal((await worker.steer(steerNote("note-b"))).delivery, "now");
    await until(
      () => field(record(scene, "operation-1/started.json"), "attempt") === 2,
    );
    await until(() => !alive(scene.turns()[0]?.processId ?? 0));
    await worker.close();
    assert.deepEqual(await receivedNotes(scene.journal, ["operation-1"]), {});
    assert.equal(scene.turns().length, 1);
    rmSync(join(folder, "attempt-2"));
    const next = scene.worker("crash-once");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    const resumed = scene.turns()[1];
    assert.ok(resumed);
    assert.deepEqual(
      resumed.arguments.slice(resumed.arguments.indexOf("--resume")),
      ["--resume", "session-1"],
    );
    assert.match(resumed.prompt, /^This turn stopped because/);
    assert.equal(field(scene.reports[0], "outcome"), "completed");
  }));

await test("CLV-327 a restart before a resumed attempt prints its session resumes the session of the earlier attempt", () =>
  withScene(async (scene) => {
    const running = (attempt: number) => () =>
      field(
        record(scene, `operation-1/attempt-${String(attempt)}.json`),
        "phase",
      ) === "running";
    const worker = scene.worker("quiet-resume");
    await worker.deliver(intent(), signal);
    await sessionAt(scene, 1);
    assert.equal((await worker.steer(steerNote("note-b"))).delivery, "now");
    await until(() => scene.turns().length === 2);
    await until(running(2));
    await worker.close();
    const next = scene.worker("quiet-resume");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.turns().length === 3);
    const resumed = scene.turns()[2];
    assert.ok(resumed);
    assert.deepEqual(
      resumed.arguments.slice(resumed.arguments.indexOf("--resume")),
      ["--resume", "session-1"],
    );
    assert.match(resumed.prompt, /^This turn stopped because/);
  }));

await test("CLV-327 a fresh retry after a capacity refusal of the resumed attempt keeps the note in its prompt", () =>
  withScene(async (scene) => {
    const worker = scene.worker("steer-capacity", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await sessionAt(scene, 1);
    assert.equal((await worker.steer(steerNote("note-b"))).delivery, "now");
    await until(() => scene.reports.length === 1);
    const [, resumed, retried, ...others] = scene.turns();
    assert.ok(resumed && retried);
    assert.deepEqual(others, []);
    assert.ok(resumed.arguments.includes("--resume"));
    assert.equal(retried.arguments.includes("--resume"), false);
    assert.match(
      retried.prompt,
      /^An earlier attempt stopped because the model/,
    );
    assert.ok(
      retried.prompt.endsWith(
        `prompt of sha256:prompt\n\nA person sent this note while you worked:\n\n${text}`,
      ),
    );
    assert.equal(field(scene.reports[0], "outcome"), "completed");
  }));

await test("CLV-327 a turn that a daemon restart resumes keeps the count of its notes sent now, and a fourth note waits for the next turn", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await steeredThreeTimes(scene, worker);
    await worker.close();
    const next = scene.worker("hold");
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await sessionAt(scene, 5);
    assert.deepEqual(await next.steer(steerNote("note-e")), {
      delivery: "queued",
      reason: "note-limit",
    });
    assert.equal(scene.turns().length, 5);
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "notes"),
      ["note-b", "note-c", "note-d"],
    );
  }));

await test("CLV-327 status and recovery keep the reason steer of a saved attempt, and recovery reads a turn with three steered attempts and two retries", async () => {
  const reasons = [
    undefined,
    "steer",
    "steer",
    "steer",
    undefined,
    "daemon-restart",
  ];
  const records = reasons.map((resumedAfter, index) => ({
    attempt: index + 1,
    model: "main",
    sessionId: index === 4 ? "session-2" : "session-1",
    ...(resumedAfter === undefined ? {} : { resumedAfter }),
  }));
  assert.deepEqual(
    attemptsOf(records)?.map((attempt) => attempt.resumedAfter),
    reasons,
  );
  const folder = mkdtempSync(join(tmpdir(), "cloving-steer-records-"));
  try {
    for (const entry of records)
      writeFileSync(
        join(folder, `attempt-${String(entry.attempt)}.json`),
        JSON.stringify(entry),
      );
    const resume = await readResume(folder, {
      attempt: 6,
      phase: "running",
      startedAt: "2026-11-08T12:00:00.000Z",
      steerNotes: ["note-b", "note-c", "note-d"],
    });
    assert.ok(resume);
    assert.deepEqual(
      resume.ends.map((end) => end.resumedAfter),
      reasons,
    );
    assert.deepEqual(resume.steerNotes, ["note-b", "note-c", "note-d"]);
    assert.equal(resume.sessionId, "session-1");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
