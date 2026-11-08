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

function startedRecord(
  scene: { readonly journal: string },
  entry: { readonly operationId: string; readonly value: object },
): void {
  const folder = join(scene.journal, journalKey(entry.operationId));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "started.json"), JSON.stringify(entry.value));
}

await test("CLV-326 a note counts as received only when the journal shows that the agent of the turn started", () =>
  withScene(async (scene) => {
    const records = [
      ["planned", { phase: "starting", attempt: 1, processId: null }],
      ["no-process", { phase: "running", attempt: 1, processId: null }],
      ["running", { phase: "running", attempt: 1, processId: 4321 }],
      ["waiting", { phase: "waiting", attempt: 1, processId: null }],
      ["second", { phase: "starting", attempt: 2, processId: null }],
    ] as const;
    for (const [operationId, value] of records)
      startedRecord(scene, {
        operationId,
        value: { ...value, notes: [`note-${operationId}`] },
      });
    assert.deepEqual(
      await receivedNotes(
        scene.journal,
        records.map(([operationId]) => operationId),
      ),
      {
        "note-running": "running",
        "note-waiting": "waiting",
        "note-second": "second",
      },
    );
  }));

await test("CLV-326 a turn that the daemon stopped before its agent started does not keep the note, so the next turn of the run gets it", () =>
  withScene(async (scene) => {
    startedRecord(scene, {
      operationId: "operation-1",
      value: {
        phase: "starting",
        attempt: 1,
        processId: null,
        harness: "claude",
        startedAt: "2026-11-08T10:00:00.000Z",
        notes: ["note-a"],
      },
    });
    const worker = scene.worker(
      "complete",
      notePort(["operation-1", "operation-2"]),
    );
    assert.equal((await worker.reconcile(intent(), signal)).kind, "failed");
    await worker.deliver(intent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene.turns().map((turn) => turn.prompt),
      [`${section}prompt of sha256:prompt`],
    );
    assert.deepEqual(
      await receivedNotes(scene.journal, ["operation-1", "operation-2"]),
      { "note-a": "operation-2" },
    );
  }));

await test("CLV-326 a turn that stops before its agent starts gives the note back, so the next turn in the same daemon gets it", () =>
  withScene(async (scene) => {
    const stopping = new AbortController();
    const worker = scene.worker("complete", {
      notes: {
        read: () => Promise.resolve([{ noteId: "note-a", text }]),
        operations: () => {
          stopping.abort();
          return Promise.resolve(["operation-1", "operation-2"]);
        },
      },
    });
    await worker.deliver(intent(), stopping.signal);
    await until(() => scene.reports.length === 1);
    assert.equal(
      field(record(scene, "operation-1/started.json"), "phase"),
      "starting",
    );
    await worker.deliver(intent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 2);
    assert.deepEqual(
      scene.turns().map((turn) => turn.prompt),
      [`${section}prompt of sha256:prompt`],
    );
  }));
