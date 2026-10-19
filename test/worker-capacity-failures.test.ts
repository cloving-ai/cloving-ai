import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-127 a missing retry result fails once and leaves unknown totals unknown", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-no-result", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "claude-turn-failed");
    assert.equal(scene.turns().length, 2);
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["costUsd"], null);
    assert.equal(result["turns"], null);
    assert.deepEqual(result["usage"], {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    });
  }));

await test("CLV-127 an unknown retry usage field does not erase known fields or invent a cost", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-unknown", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["costUsd"], null);
    assert.deepEqual(result["usage"], {
      input_tokens: 1502,
      cache_read_input_tokens: null,
      output_tokens: null,
    });
  }));

await test("CLV-127 a failed attempt journal write stops the launched process before rejecting", () =>
  withScene(async (scene) => {
    const folder = join(scene.journal, journalKey("operation-1"));
    mkdirSync(join(folder, "attempt-1.json"), { recursive: true });
    const worker = scene.worker("hold");
    await assert.rejects(worker.deliver(intent(), signal));
    const processId = field(
      record(scene, "operation-1/started.json"),
      "processId",
    );
    assert.equal(typeof processId, "number");
    assert.equal(alive(Number(processId)), false);
    assert.equal((await worker.reconcile(intent(), signal)).kind, "failed");
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-127 a failed retry clock leaves the operation for recovery without relaunching", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-always", {
      retryDelay: () => Promise.reject(new Error("clock-failed")),
    });
    await worker.deliver(intent(), signal);
    await until(
      async () => (await worker.reconcile(intent(), signal)).kind === "failed",
    );
    assert.equal(
      field(record(scene, "operation-1/started.json"), "phase"),
      "waiting",
    );
    await worker.close();
    const recovered = await worker.reconcile(intent(), signal);
    assert.equal(recovered.kind, "failed");
    assert.equal(field(recovered, "reason"), "claude-turn-interrupted");
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports.length, 0);
  }));
