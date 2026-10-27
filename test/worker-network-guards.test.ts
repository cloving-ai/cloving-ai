import assert from "node:assert/strict";
import { test } from "node:test";
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
