import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-239 startup recovery on a closed worker cannot report its daemon shutdown", () =>
  withScene(async (scene) => {
    const worker = scene.worker("resume-once");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    await worker.close();
    await worker.recover(intent());
    assert.equal(scene.reports.length, 0);
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-239 worker startup resumes and reports one completed turn", () =>
  withScene(async (scene) => {
    const first = scene.worker("resume-once");
    await first.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    await first.close();
    await scene.worker("resume-once").recover(intent());
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(resultOf(scene.reports[0].result)["costUsd"], 2);
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-239 worker startup ignores absent records and incomplete intents", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.recover(intent());
    await worker.recover(intent({ capability: "github" }));
    await worker.recover(intent({ method: "run-turn:analyze-chats" }));
    assert.equal(scene.reports.length, 0);
    assert.equal(scene.turns().length, 0);
  }));

for (const scenario of [
  { budget: 5, removeSession: true, reason: "claude-turn-interrupted" },
  { budget: 1.2, removeSession: false, reason: "claude-turn-budget-exhausted" },
])
  await test(`CLV-239 worker startup reports ${scenario.reason} without launching a resume`, () =>
    withScene(async (scene) => {
      const settings = {
        profiles: { main: { model: "sonnet", maxBudgetUsd: scenario.budget } },
      };
      const operation = intent({ method: "run-turn:main" });
      const first = scene.worker("resume-once", settings);
      await first.deliver(operation, signal);
      await until(
        () =>
          field(
            record(scene, "operation-1/attempt-1.json"),
            "sessionCostUsd",
          ) === 1.2,
      );
      await first.close();
      const previous = record(scene, "operation-1/attempt-1.json");
      assert.ok(typeof previous === "object" && previous !== null);
      const updated = { ...previous };
      if (scenario.removeSession) Reflect.deleteProperty(updated, "sessionId");
      writeFileSync(
        join(scene.journal, journalKey("operation-1"), "attempt-1.json"),
        JSON.stringify(updated),
      );
      await scene.worker("resume-once", settings).recover(operation);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "failed");
      assert.equal(scene.reports[0].reason, scenario.reason);
      assert.equal(scene.reports.length, 1);
      assert.equal(scene.turns().length, 1);
    }));

for (const ending of [
  { outcome: "completed", result: "Stored completion" },
  { outcome: "failed", reason: "claude-turn-interrupted" },
  { outcome: "failed", reason: "claude-turn-budget-exhausted" },
  { outcome: "stopped" },
] as const)
  await test(`CLV-239 worker startup reports ${JSON.stringify(ending)} without another process`, () =>
    withScene(async (scene) => {
      const folder = join(scene.journal, journalKey("operation-1"));
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "started.json"),
        JSON.stringify({ harness: "claude" }),
      );
      writeFileSync(
        join(folder, "result.json"),
        JSON.stringify({ ...ending, endedAt: "2026-10-01T00:00:00Z" }),
      );
      await scene.worker("hold").recover(intent());
      const operation = intent();
      assert.deepEqual(scene.reports, [
        {
          runId: operation.runId,
          commandId: `claude-turn:${journalKey(operation.operationId)}`,
          operationId: operation.operationId,
          inputDigest: operation.inputDigest,
          leaseGeneration: operation.leaseGeneration,
          worker: "claude",
          ...ending,
        },
      ]);
      assert.equal(scene.turns().length, 0);
    }));

await test("CLV-239 recovery requires a complete intent and an available Claude profile", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    assert.equal(await worker.harness("operation-1"), "claude");
    assert.equal(await worker.harness("missing"), undefined);
    const saved = record(scene, "operation-1/result.json");
    const path = join(scene.journal, journalKey("operation-1"), "result.json");
    for (const name of [
      "capability",
      "method",
      "target",
      "payload",
      "leaseGeneration",
    ]) {
      const incomplete = { ...intent() };
      Reflect.deleteProperty(incomplete, name);
      writeFileSync(path, JSON.stringify(saved));
      const reply = await scene.worker("hold").reconcile(incomplete, signal);
      assert.equal(field(reply, "reason"), "claude-turn-interrupted");
    }
    writeFileSync(path, JSON.stringify(saved));
    const unavailable = await scene
      .worker("hold")
      .reconcile(intent({ method: "run-turn:missing" }), signal);
    assert.equal(field(unavailable, "reason"), "claude-turn-interrupted");
    writeFileSync(path, JSON.stringify(saved));
    const changed = await scene
      .worker("hold", { worker: "codex" })
      .reconcile(intent(), signal);
    assert.equal(field(changed, "reason"), "claude-turn-interrupted");
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-239 recovery accepts recorded session cost without a cumulative-cost field", () =>
  withScene(async (scene) => {
    const settings = {
      profiles: { main: { model: "sonnet", maxBudgetUsd: 5 } },
    };
    const operation = intent({ method: "run-turn:main" });
    const worker = scene.worker("resume-once", settings);
    await worker.deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    await worker.close();
    const folder = join(scene.journal, journalKey("operation-1"));
    const previous = record(scene, "operation-1/attempt-1.json");
    const started = record(scene, "operation-1/started.json");
    assert.ok(typeof previous === "object" && previous !== null);
    assert.ok(typeof started === "object" && started !== null);
    const legacy = { ...previous };
    Reflect.deleteProperty(legacy, "sessionCostUsd");
    Reflect.deleteProperty(legacy, "retryKind");
    writeFileSync(join(folder, "attempt-1.json"), JSON.stringify(legacy));
    writeFileSync(
      join(folder, "started.json"),
      JSON.stringify({ ...started, turnStartCommit: null }),
    );
    const next = scene.worker("resume-once", settings);
    assert.equal((await next.reconcile(operation, signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(resultOf(scene.reports[0]?.result)["costUsd"], 2);
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "costUsd"),
      0.8,
    );
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "budgetUsd"),
      3.8,
    );
  }));
