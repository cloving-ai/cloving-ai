import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  field,
  record,
  intent,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { networkCommand } from "./network-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-229 two network failures wait ten then forty minutes and sum all attempts", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "network", "done"]),
      retryDelay: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.deepEqual(waits, [600_000, 2_400_000]);
    const turns = scene.turns();
    assert.equal(turns.length, 3);
    assert.ok(turns.every((turn) => turn.directory === turns[0]?.directory));
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["summary"], "Done");
    assert.equal(result["costUsd"], 0.1 + 0.2 + 0.3);
    assert.equal(result["turns"], 6);
    assert.deepEqual(result["usage"], {
      input_tokens: 600,
      cache_read_input_tokens: 0,
      output_tokens: 60,
    });
    const activity = readFileSync(
      join(scene.journal, journalKey("operation-1"), "turn.jsonl"),
      "utf8",
    );
    assert.equal(activity.match(/"type":"result"/g)?.length, 3);
  }));

await test("CLV-229 three network failures exhaust the shared three-attempt limit", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("unused", {
      command: networkCommand(scene, Array<string>(4).fill("network")),
      retryDelay: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.turns().length, 3);
    assert.equal(scene.reports[0]?.reason, "claude-turn-failed");
    assert.deepEqual(waits, [600_000, 2_400_000]);
  }));

await test("CLV-229 an API 400 failure does not retry", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["bad", "done"]),
      retryDelay: () => Promise.reject(new Error("unexpected-retry")),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports[0]?.reason, "claude-turn-failed");
  }));

await test("CLV-229 stopping a network wait starts no second attempt", () =>
  withScene(async (scene) => {
    let waiting = false;
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "done"]),
      retryDelay: (milliseconds, stopping) => {
        waiting = true;
        return delay(milliseconds, undefined, { signal: stopping });
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => waiting || scene.reports.length > 0);
    assert.equal(waiting, true);
    assert.equal((await worker.stop(intent(), signal)).kind, "stopped");
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports[0]?.outcome, "stopped");
  }));

await test("CLV-229 the recorded turn head survives a network wait and attempt completion", () =>
  withScene(async (scene) => {
    let waitingHead: unknown;
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "done"]),
      retryDelay: () => {
        waitingHead = field(
          record(scene, "operation-1/started.json"),
          "turnStartCommit",
        );
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(typeof waitingHead, "string");
    assert.equal(
      field(record(scene, "operation-1/attempt-1.json"), "turnStartCommit"),
      waitingHead,
    );
  }));
