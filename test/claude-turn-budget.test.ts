import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  field,
  alive,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { networkCommand } from "./network-worker-fixture.ts";
import { startTurn } from "../src/daemon/claude-turn.ts";

const signal = new AbortController().signal;
const operation = intent({ method: "run-turn:budgeted" });
const settings = {
  profiles: { budgeted: { maxBudgetUsd: 5 } },
  retryDelay: () => Promise.resolve(),
};

await test("CLV-239 streamed cost is saved while the process is alive for crash recovery", () =>
  withScene(async (scene) => {
    await scene.worker("resume-once", settings).deliver(operation, signal);
    await until(() => {
      const path = join(scene.journal, journalKey("operation-1"), "turn.jsonl");
      return (
        scene.turns().length === 1 &&
        readFileSync(path, "utf8").includes('"total_cost_usd":1.2')
      );
    });
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    assert.equal(
      field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd"),
      1.2,
    );
  }));

await test("CLV-239 resumed cumulative session costs and new-session retries share one budget", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const options = {
      ...settings,
      retryDelay: (milliseconds: number) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    };
    const worker = scene.worker("resume-cost", options);
    await worker.deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    await worker.close();
    await scene.worker("resume-cost", options).reconcile(operation, signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.deepEqual(waits, [60_000]);
    const budgets = scene
      .turns()
      .map((turn) =>
        Number(turn.arguments[turn.arguments.indexOf("--max-budget-usd") + 1]),
      );
    assert.deepEqual(budgets, [5, 3.8, 3]);
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["costUsd"], 2.5);
    const attempts = result["attempts"];
    assert.ok(Array.isArray(attempts));
    assert.deepEqual(
      attempts.map((attempt: unknown) => field(attempt, "costUsd")),
      [1.2, 0.8, 0.5],
    );
    assert.equal(field(attempts[1], "resumedAfter"), "daemon-restart");
    for (const [index, cost] of [1.2, 0.8, 0.5].entries())
      assert.equal(
        field(
          record(scene, `operation-1/attempt-${String(index + 1)}.json`),
          "costUsd",
        ),
        cost,
      );
    const activity = readFileSync(
      join(scene.journal, journalKey("operation-1"), "turn.jsonl"),
      "utf8",
    );
    assert.equal(activity.match(/"type":"result"/g)?.length, 4);
  }));

await test("CLV-239 an exhausted retry budget fails without another process", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-always", {
      ...settings,
      profiles: { budgeted: { maxBudgetUsd: 0.25 } },
    });
    await worker.deliver(operation, signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "claude-turn-budget-exhausted");
    assert.equal(scene.turns().length, 1);
    assert.equal(record(scene, "operation-1/attempt-2.json"), undefined);
  }));

await test("CLV-239 unknown cost keeps and records the full budget for a retry and a resume", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-unknown-first", settings);
    await worker.deliver(operation, signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene.turns().map((turn) => turn.arguments.at(-1)),
      ["5", "5"],
    );
    assert.equal(
      field(record(scene, "operation-1/attempt-2.json"), "budgetUsd"),
      5,
    );
    assert.equal(resultOf(scene.reports[0]?.result)["costUsd"], null);
    const held = scene.worker("hold", settings);
    const second = intent({
      operationId: "unknown-resume",
      method: "run-turn:budgeted",
    });
    await held.deliver(second, signal);
    await until(
      () =>
        typeof field(
          record(scene, "unknown-resume/attempt-1.json"),
          "sessionId",
        ) === "string",
    );
    await held.close();
    await scene.worker("complete", settings).reconcile(second, signal);
    await until(() => scene.reports.length === 2);
    assert.equal(
      field(record(scene, "unknown-resume/attempt-2.json"), "budgetUsd"),
      5,
    );
  }));

await test("CLV-239 a fully spent session cannot start a resumed process", () =>
  withScene(async (scene) => {
    const options = { profiles: { budgeted: { maxBudgetUsd: 1.2 } } };
    const worker = scene.worker("resume-once", options);
    await worker.deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    await worker.close();
    await scene.worker("resume-once", options).reconcile(operation, signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "claude-turn-budget-exhausted");
    assert.equal(scene.turns().length, 1);
    assert.equal(record(scene, "operation-1/attempt-2.json"), undefined);
  }));

await test("CLV-239 each network retry gets the unspent command budget", () =>
  withScene(async (scene) => {
    await scene
      .worker("unused", {
        command: [
          ...networkCommand(scene, ["network", "network", "done"]),
          "--max-budget-usd=5",
        ],
        retryDelay: () => Promise.resolve(),
      })
      .deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene.turns().map((turn) => Number(turn.arguments.at(-1))),
      [5, 4.9, 4.7],
    );
  }));

await test("CLV-239 prompt arguments after the separator never add a budget", () =>
  withScene(async (scene) => {
    await scene
      .worker("unused", {
        command: [
          process.execPath,
          join(scene.directory, "fake-claude.mjs"),
          "complete",
          join(scene.directory, "turns.log"),
          "--",
          "--max-budget-usd=5",
        ],
      })
      .deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(scene.turns()[0]?.arguments.slice(2), [
      "--",
      "--max-budget-usd=5",
    ]);
    assert.equal(
      field(record(scene, "operation-1/attempt-1.json"), "budgetUsd"),
      undefined,
    );
  }));

await test("CLV-239 the last command budget option selects the turn budget", () =>
  withScene(async (scene) => {
    await scene
      .worker("unused", {
        command: [
          process.execPath,
          join(scene.directory, "fake-claude.mjs"),
          "complete",
          join(scene.directory, "turns.log"),
          "--max-budget-usd",
          "7",
          "--max-budget-usd",
          "5",
        ],
      })
      .deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(
      field(record(scene, "operation-1/attempt-1.json"), "budgetUsd"),
      5,
    );
  }));

await test("CLV-239 a progress journal failure stops a live process and rejects its end", () =>
  withScene(async (scene) => {
    const folder = join(scene.directory, "journal-failure");
    mkdirSync(folder);
    const turn = startTurn({
      command: [
        process.execPath,
        join(scene.directory, "fake-claude.mjs"),
        "hold",
        join(scene.directory, "turns.log"),
      ],
      directory: scene.repository,
      folder,
      prompt: "Save the session",
      progress: () => Promise.reject(new Error("disk-full")),
    });
    const ending = turn.ended.catch((error: unknown) => error);
    try {
      await until(() => scene.turns().length === 1);
      await until(() => turn.processId !== null && !alive(turn.processId));
      const error = await ending;
      assert.ok(error instanceof Error);
      assert.equal(error.message, "disk-full");
    } finally {
      turn.stop(0);
      await ending;
    }
  }));
