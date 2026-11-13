import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  field,
  intent,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { networkCommand } from "./network-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-229 Codex unreachable text never enables the Claude network retry", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      worker: "codex",
      command: networkCommand(scene, {
        failures: ["network", "done"],
        worker: "codex",
      }),
      retryDelay: () => Promise.reject(new Error("unexpected-network-retry")),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.turns().length, 1);
    assert.equal(
      field(record(scene, "operation-1/attempt-1.json"), "retryKind"),
      null,
    );
  }));

await test("CLV-229 retained analysis turns keep their current refusal and cannot start network retries", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "done"]),
      profiles: { "analyze-chats": { allowedTools: ["Read"] } },
      workflowId: () => Promise.resolve("analyze-chats"),
    });
    assert.deepEqual(
      await worker.deliver(
        intent({ method: "run-turn:analyze-chats" }),
        signal,
      ),
      {
        kind: "failed",
        reason: "unsupported-effect",
      },
    );
    assert.deepEqual(scene.turns(), []);
  }));

await test("CLV-229 recovery of a network wait fails the interrupted operation instead of resuming it", () =>
  withScene(async (scene) => {
    const settings = {
      command: networkCommand(scene, ["network", "done"]),
      retryDelay: () => Promise.reject(new Error("lost-clock")),
    };
    const worker = scene.worker("unused", settings);
    await worker.deliver(intent(), signal);
    await until(
      async () => (await worker.reconcile(intent(), signal)).kind === "failed",
    );
    const restarted = scene.worker("unused", settings);
    const recovered = await restarted.deliver(intent(), signal);
    assert.equal(field(recovered, "kind"), "failed");
    assert.equal(field(recovered, "reason"), "claude-turn-interrupted");
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-348 a network wait that the old service stopped continues in the new worker and then starts a new attempt with no session resume", () =>
  withScene(async (scene) => {
    const command = networkCommand(scene, ["network", "done"]);
    let waited = 0;
    const worker = scene.worker("unused", {
      command,
      retryDelay: (milliseconds, stopping) => {
        waited = milliseconds;
        return delay(milliseconds, undefined, { signal: stopping });
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => waited > 0);
    assert.equal(waited, 600_000);
    await worker.close();
    const restarted = scene.worker("unused", {
      command,
      retryDelay: () => Promise.resolve(),
    });
    const recovered = await restarted.deliver(intent(), signal);
    assert.equal(field(recovered, "kind"), "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const [, retried] = scene.turns();
    assert.ok(retried);
    assert.match(retried.prompt, /the network was not available/);
    assert.equal(retried.arguments.includes("--resume"), false);
    assert.equal(scene.turns().length, 2);
  }));
