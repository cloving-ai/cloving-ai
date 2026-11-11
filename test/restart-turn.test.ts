import assert from "node:assert/strict";
import { test } from "node:test";
import { field, items } from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";
import {
  admittedTurn,
  assistantTexts,
  finishedRun,
  lineTurn,
  restartedTurns,
  startedTurn,
  withTurnHost,
  writingTurn,
  writtenLines,
} from "./restart-turn-fixture.ts";

function alive(processId: number): boolean {
  try {
    return process.kill(processId, 0);
  } catch {
    return false;
  }
}

await test("CLV-347 cloving restart in the middle of a 60-second turn starts the new service within 10 seconds, the turn keeps its process, the watch transcript has each line one time, and the turn ends with its result and one cost", () =>
  withTurnHost({ script: lineTurn }, async (scene) => {
    const { fixture } = scene;
    const runId = await admittedTurn(fixture, "lines");
    const writing = await writingTurn(scene, runId);
    const before = await call(fixture, { operation: "status", parameters: {} });
    const requested = Date.now();
    const turns = await restartedTurns(fixture, []);
    assert.deepEqual(field(turns, "connected"), [runId]);
    const after = await call(fixture, { operation: "status", parameters: {} });
    assert.notEqual(after["serviceStartedAt"], before["serviceStartedAt"]);
    const startedAt = Date.parse(String(after["serviceStartedAt"]));
    assert.ok(
      startedAt - requested < 10_000,
      `The new service started ${String(startedAt - requested)} ms after the request.`,
    );
    assert.equal(alive(writing.processId), true);
    const run = await finishedRun(fixture, runId);
    assert.equal(field(run, "state"), "completed", JSON.stringify(run));
    assert.deepEqual(
      assistantTexts(await writing.watch.closed),
      writtenLines(writing.processId),
    );
    assert.equal(field(run, "claudeCostUsd"), 0.25);
    const workerTurns = items(field(run, "workerTurns"));
    assert.equal(workerTurns.length, 1, JSON.stringify(workerTurns));
    assert.equal(items(field(workerTurns[0], "attempts")).length, 1);
    const ended = await startedTurn(fixture, runId);
    assert.deepEqual(ended.launch, writing.turn.launch);
  }));
