import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  alive,
  field,
  git,
  intent,
  journalKey,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-239 a killed Claude child resumes before reporting a terminal result", () =>
  withScene(async (scene) => {
    const worker = scene.worker("crash-once");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    const first = scene.turns()[0];
    assert.ok(first);
    process.kill(first.processId, "SIGKILL");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 2);
    assert.deepEqual(scene.turns()[1]?.arguments.slice(-2), [
      "--resume",
      "session-1",
    ]);
    assert.match(scene.turns()[1]?.prompt ?? "", /Continue the task/);
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "resumedAfter"),
      "daemon-restart",
    );
    assert.equal((await worker.reconcile(intent(), signal)).kind, "completed");
    assert.equal(scene.reports.length, 1);
  }));

await test("CLV-239 a live daemon stops recovering after two child resumes", () =>
  withScene(async (scene) => {
    await scene.worker("hold").deliver(intent(), signal);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await until(
        () =>
          field(
            record(scene, `operation-1/attempt-${String(attempt)}.json`),
            "sessionId",
          ) === "session-1",
      );
      const current = scene.turns().at(-1);
      assert.ok(current);
      process.kill(current.processId, "SIGKILL");
      await until(
        () => scene.turns().length > attempt || scene.reports.length > 0,
      );
    }
    assert.equal(scene.turns().length, 3);
    assert.deepEqual(
      scene.reports.map(({ outcome, reason }) => ({ outcome, reason })),
      [{ outcome: "failed", reason: "claude-turn-interrupted" }],
    );
  }));

await test("CLV-239 a killed child refuses recovery for missing-session", () =>
  withScene(async (scene) => {
    await scene.worker("hold").deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    const current = scene.turns()[0];
    assert.ok(current);
    const saved = record(scene, "operation-1/attempt-1.json");
    assert.ok(typeof saved === "object" && saved !== null);
    writeFileSync(
      join(scene.journal, journalKey("operation-1"), "attempt-1.json"),
      JSON.stringify({ ...saved, sessionId: null }),
    );
    process.kill(current.processId, "SIGKILL");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "claude-turn-interrupted");
  }));

await test("CLV-239 a child resume records the full budget when its cost is unknown", () =>
  withScene(async (scene) => {
    const operation = intent({ method: "run-turn:budgeted" });
    await scene
      .worker("crash-once", {
        profiles: { budgeted: { maxBudgetUsd: 5 } },
      })
      .deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    const first = scene.turns()[0];
    assert.ok(first);
    process.kill(first.processId, "SIGKILL");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.deepEqual(
      scene
        .turns()
        .map(
          (turn) =>
            turn.arguments[turn.arguments.indexOf("--max-budget-usd") + 1],
        ),
      ["5", "5"],
    );
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "budgetUsd"),
      5,
    );
  }));

await test("CLV-239 a daemon restart preserves the interrupted fallback model", () =>
  withScene(async (scene) => {
    const settings = {
      profiles: { main: { model: "opus" } },
      fallbackModels: ["sonnet"],
      retryDelay: () => Promise.resolve(),
    };
    const operation = intent({ method: "run-turn:main" });
    const first = scene.worker("fallback-resume", settings);
    await first.deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-3.json"), "sessionId") ===
        "session-3",
    );
    await first.close();
    assert.equal(
      (
        await scene
          .worker("fallback-resume", settings)
          .reconcile(operation, signal)
      ).kind,
      "accepted",
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.deepEqual(
      scene
        .turns()
        .map((turn) => turn.arguments[turn.arguments.indexOf("--model") + 1]),
      ["opus", "opus", "sonnet", "sonnet"],
    );
    assert.deepEqual(scene.turns()[3]?.arguments.slice(-2), [
      "--resume",
      "session-3",
    ]);
    assert.equal(
      field(record(scene, "operation-1/attempt-4.json"), "model"),
      "sonnet",
    );
  }));

await test("CLV-240 a leftover child in a nested folder stops before a killed turn resumes", () =>
  withScene(async (scene) => {
    await scene.worker("tool-child").deliver(intent(), signal);
    const childFile = join(scene.directory, "turns.log.child");
    await until(() => existsSync(childFile + ".lines"));
    const childId = Number(readFileSync(childFile, "utf8"));
    const first = scene.turns()[0];
    assert.ok(first);
    const lockPath = git(first.directory, [
      "rev-parse",
      "--git-path",
      "index.lock",
    ]);
    writeFileSync(lockPath, "held by child");
    process.kill(first.processId, "SIGKILL");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(existsSync(lockPath), false);
    assert.equal(alive(childId), false);
    const lines = readFileSync(childFile + ".lines", "utf8");
    await delay(30);
    assert.equal(readFileSync(childFile + ".lines", "utf8"), lines);
    assert.equal(scene.turns().length, 2);
  }));
