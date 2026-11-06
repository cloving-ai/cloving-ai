import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { record, type Fields } from "../src/protocol.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";
import { call, eventually, field } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

type Scene = Parameters<Parameters<typeof withQueueSpend>[0]>[0];

async function revision(scene: Scene, runId: string): Promise<number> {
  const shown = await call(scene.harness, {
    operation: "status",
    parameters: { runId },
  });
  return Number(field(shown["run"], "revision"));
}

async function submitted(scene: Scene, command: Fields): Promise<void> {
  const receipt = await scene.worker().submit(command);
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
}

async function failedRun(scene: Scene, name: string): Promise<string> {
  const runId = await scene.begin(name, "queued");
  await scene.turn(runId, { costUsd: 1 });
  await submitted(scene, {
    kind: "fail-run",
    commandId: `${name}-fail`,
    runId,
    expectedRevision: await revision(scene, runId),
  });
  return runId;
}

async function startedContinuation(
  scene: Scene,
  runId: string,
): Promise<string> {
  const reply = await call(scene.harness, {
    operation: "continue-run",
    parameters: { runId, commandId: "continue-second", from: "work/turn/1" },
  });
  assert.equal(reply["kind"], "run-continued", JSON.stringify(reply));
  const continuation = String(reply["runId"]);
  await eventually(async () => {
    const events = await call(scene.harness, {
      operation: "events",
      parameters: { runId: continuation, after: 0, limit: 100 },
    });
    return JSON.stringify(events).includes("step.dispatched")
      ? true
      : undefined;
  });
  const started = await scene.worker().started({
    runId: continuation,
    commandId: "continue-second-started",
    expectedRevision: 1,
  });
  assert.equal(started.kind, "accepted", JSON.stringify(started));
  return continuation;
}

await test("CLV-307 a continuation that hands off clears the queue failure streak of its failed run", () =>
  withQueueSpend(async (scene) => {
    const failures = [
      await failedRun(scene, "first"),
      await failedRun(scene, "second"),
      await failedRun(scene, "third"),
    ];
    const journal = join(scene.harness.stateDirectory, "queue-commands.json");
    await writeFile(journal, JSON.stringify({ commands: [], failures }));
    const saved = async () =>
      record(JSON.parse(await readFile(journal, "utf8")))?.["failures"];
    const continuation = await startedContinuation(scene, String(failures[1]));
    scene.startQueue();
    await delay(testMilliseconds(200));
    assert.deepEqual(await saved(), failures);
    await scene.finish(continuation);
    await eventually(async () => {
      const left = await saved();
      return Array.isArray(left) && left.length === 0 ? true : undefined;
    });
  }));
