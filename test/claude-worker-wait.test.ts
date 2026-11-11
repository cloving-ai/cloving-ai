import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TurnRecovery } from "../src/turn-recovery.ts";
import {
  field,
  intent,
  journalKey,
  record,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const firstWait = 60_000;

interface RecordedWaits {
  readonly calls: number[];
  readonly retryDelay: (
    milliseconds: number,
    stop: AbortSignal,
  ) => Promise<void>;
}

function heldWaits(): RecordedWaits {
  const calls: number[] = [];
  return {
    calls,
    retryDelay: (milliseconds, stop) => {
      calls.push(milliseconds);
      return new Promise((resolve) => {
        if (stop.aborted) resolve();
        stop.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
    },
  };
}

function passedWaits(): RecordedWaits {
  const calls: number[] = [];
  return {
    calls,
    retryDelay: (milliseconds) => {
      calls.push(milliseconds);
      return Promise.resolve();
    },
  };
}

async function waitingTurn(scene: Scene, mode: string): Promise<void> {
  const waits = heldWaits();
  const worker = scene.worker(mode, { retryDelay: waits.retryDelay });
  await worker.deliver(intent(), signal);
  await until(() => waits.calls.length === 1);
  await worker.close({ turns: "keep" });
  assert.deepEqual(waits.calls, [firstWait]);
  assert.equal(
    field(record(scene, "operation-1/result.json"), "stoppedBy"),
    "daemon-shutdown",
  );
}

function savedWait(scene: Scene, endsIn: number): number {
  const path = join(scene.journal, journalKey("operation-1"), "started.json");
  const started: unknown = JSON.parse(readFileSync(path, "utf8"));
  const endsAt = Date.now() + endsIn;
  writeFileSync(
    path,
    JSON.stringify({
      ...Object(started),
      waitingAt: new Date(endsAt - firstWait).toISOString(),
    }),
  );
  return endsAt;
}

function attemptStart(scene: Scene, attempt: number): number {
  const entry = record(scene, `operation-1/attempt-${String(attempt)}.json`);
  return Date.parse(String(field(entry, "startedAt")));
}

await test("CLV-348 a new worker waits for the rest of the saved retry wait and then starts the next attempt", () =>
  withScene(async (scene) => {
    await waitingTurn(scene, "capacity-once");
    const endsAt = savedWait(scene, 1500);
    const recoveries: TurnRecovery[] = [];
    const next = scene.worker("capacity-once", {
      recovered: (recovery) => recoveries.push(recovery),
    });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.deepEqual(recoveries, [{ runId: "run-1", way: "waiting" }]);
    assert.equal(scene.turns().length, 1);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["completed"],
    );
    const started = attemptStart(scene, 2);
    assert.ok(started >= endsAt - 1, `${String(started)} < ${String(endsAt)}`);
    assert.ok(started <= endsAt + 2000, `${String(started - endsAt)} ms late`);
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "attempt"),
      2,
    );
    const [, retried] = scene.turns();
    assert.ok(retried);
    assert.match(retried.prompt, /because the model was at capacity/);
    assert.equal(retried.arguments.includes("--resume"), false);
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-348 a retry wait that ended while no service ran starts the next attempt at once", () =>
  withScene(async (scene) => {
    await waitingTurn(scene, "capacity-once");
    savedWait(scene, -120_000);
    const next = scene.worker("capacity-once");
    const reconciled = Date.now();
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.ok(attemptStart(scene, 2) - reconciled < 2000);
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["completed"],
    );
  }));

await test("CLV-348 the attempts after a restart continue the attempt count and the retry limit of the turn", () =>
  withScene(async (scene) => {
    await waitingTurn(scene, "capacity-always");
    savedWait(scene, 30_000);
    const waits = passedWaits();
    const next = scene.worker("capacity-always", {
      retryDelay: waits.retryDelay,
    });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(waits.calls.length, 2);
    assert.ok((waits.calls[0] ?? 0) > 25_000);
    assert.ok((waits.calls[0] ?? Infinity) <= 30_000);
    assert.equal(waits.calls[1], 180_000);
    assert.equal(scene.turns().length, 3);
    assert.equal(
      field(record(scene, "operation-1/attempt-3.json"), "attempt"),
      3,
    );
    assert.equal(record(scene, "operation-1/attempt-4.json"), undefined);
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["failed"],
    );
  }));

await test("CLV-348 a second restart during the continued wait keeps the saved time", () =>
  withScene(async (scene) => {
    await waitingTurn(scene, "capacity-once");
    savedWait(scene, 40_000);
    const saved = record(scene, "operation-1/started.json");
    const held = heldWaits();
    const second = scene.worker("capacity-once", {
      retryDelay: held.retryDelay,
    });
    assert.equal((await second.reconcile(intent(), signal)).kind, "accepted");
    await until(() => held.calls.length === 1);
    await second.close({ turns: "keep" });
    assert.deepEqual(record(scene, "operation-1/started.json"), saved);
    assert.equal(
      field(record(scene, "operation-1/result.json"), "stoppedBy"),
      "daemon-shutdown",
    );
    const waits = passedWaits();
    const third = scene.worker("capacity-once", {
      retryDelay: waits.retryDelay,
    });
    assert.equal((await third.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.ok((waits.calls[0] ?? Infinity) <= (held.calls[0] ?? 0));
    assert.equal(scene.turns().length, 2);
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["completed"],
    );
  }));

await test("CLV-348 a drop during the continued wait stops the turn with no next attempt", () =>
  withScene(async (scene) => {
    await waitingTurn(scene, "capacity-once");
    savedWait(scene, 40_000);
    const held = heldWaits();
    const next = scene.worker("capacity-once", {
      retryDelay: held.retryDelay,
    });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => held.calls.length === 1);
    assert.equal((await next.stop(intent(), signal)).kind, "stopped");
    assert.equal(scene.turns().length, 1);
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["stopped"],
    );
  }));

await test("CLV-348 a continued wait whose profile is gone ends as an interrupted turn", () =>
  withScene(async (scene) => {
    const operation = intent({ method: "run-turn:review" });
    const waits = heldWaits();
    const worker = scene.worker("capacity-once", {
      retryDelay: waits.retryDelay,
      profiles: { review: {} },
    });
    await worker.deliver(operation, signal);
    await until(() => waits.calls.length === 1);
    await worker.close({ turns: "keep" });
    const next = scene.worker("capacity-once", { profiles: {} });
    const reply = await next.reconcile(operation, signal);
    assert.equal(field(reply, "reason"), "claude-turn-interrupted");
    assert.equal(scene.turns().length, 1);
  }));
