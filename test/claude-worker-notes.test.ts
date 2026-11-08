import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { receivedNotes } from "../src/daemon/turn-notes.ts";
import {
  field,
  intent,
  journalKey,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const text = "Merge the branch of the first run first.";
const section = `Notes from the operator:\n\n${text}\n\n`;

function notePort(operationIds: readonly string[]) {
  return {
    notes: {
      read: (runId: string) =>
        Promise.resolve(runId === "run-1" ? [{ noteId: "note-a", text }] : []),
      operations: () => Promise.resolve(operationIds),
    },
  };
}

function sections(prompt: string): number {
  return prompt.split("Notes from the operator:").length - 1;
}

await test("CLV-326 the first turn of a run gets the notes before its text and records the note IDs, and a later turn gets no notes", () =>
  withScene(async (scene) => {
    const worker = scene.worker(
      "complete",
      notePort(["operation-1", "operation-2"]),
    );
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    await worker.deliver(intent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 2);
    await worker.deliver(
      intent({ runId: "run-2", operationId: "operation-3" }),
      signal,
    );
    await until(() => scene.reports.length === 3);
    assert.deepEqual(
      scene.turns().map((turn) => turn.prompt),
      [
        `${section}prompt of sha256:prompt`,
        "prompt of sha256:prompt",
        "prompt of sha256:prompt",
      ],
    );
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "notes"),
      ["note-a"],
    );
    assert.equal(
      field(record(scene, "operation-2/started.json"), "notes"),
      undefined,
    );
    assert.deepEqual(
      await receivedNotes(scene.journal, [
        "operation-1",
        "operation-2",
        "operation-unknown",
      ]),
      { "note-a": "operation-1" },
    );
  }));

await test("CLV-326 two turns of a run that start at the same time give a note to one turn only", () =>
  withScene(async (scene) => {
    const worker = scene.worker(
      "complete",
      notePort(["operation-1", "operation-2"]),
    );
    await Promise.all([
      worker.deliver(intent(), signal),
      worker.deliver(
        intent({ operationId: "operation-2", target: "ticket/two" }),
        signal,
      ),
    ]);
    await until(() => scene.reports.length === 2);
    assert.deepEqual(
      scene
        .turns()
        .map((turn) => sections(turn.prompt))
        .sort(),
      [0, 1],
    );
  }));

await test("CLV-326 a turn that resumes after a daemon restart keeps its notes, and its retry gets them once", () =>
  withScene(async (scene) => {
    const prompt = "Implement the assigned task and end with its result line.";
    const settings = {
      document: () => Promise.resolve(prompt),
      retryDelay: () => Promise.resolve(),
      ...notePort(["operation-1"]),
    };
    const worker = scene.worker("hold", settings);
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const next = scene.worker("resume-cost", settings);
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    const [first, resumed, retried] = scene.turns();
    assert.ok(first && resumed && retried);
    assert.equal(first.prompt, `${section}${prompt}`);
    assert.match(resumed.prompt, /^This turn stopped because/);
    assert.equal(sections(resumed.prompt), 0);
    assert.ok(retried.prompt.endsWith(`\n\n${section}${prompt}`));
    assert.equal(sections(retried.prompt), 1);
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "notes"),
      ["note-a"],
    );
  }));

await test("CLV-326 a turn that does not start gives its notes back, so the next turn of the run gets them", () =>
  withScene(async (scene) => {
    mkdirSync(scene.journal, { recursive: true });
    writeFileSync(join(scene.journal, journalKey("operation-1")), "");
    const worker = scene.worker(
      "complete",
      notePort(["operation-1", "operation-2"]),
    );
    await assert.rejects(worker.deliver(intent(), signal));
    await worker.deliver(intent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene.turns().map((turn) => turn.prompt),
      [`${section}prompt of sha256:prompt`],
    );
  }));
