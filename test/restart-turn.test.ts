import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { field } from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";
import { replacementPhases } from "./restart-diagnostics-fixture.ts";
import {
  admittedTurn,
  assistantTexts,
  assertTurnResult,
  finishedRun,
  lineTurn,
  restartedTurns,
  startedTurn,
  withTurnHost,
  writingTurn,
  writtenLines,
  type TurnHost,
} from "./restart-turn-fixture.ts";

async function assertPublicClient(scene: TurnHost): Promise<void> {
  const manifest: unknown = JSON.parse(
    await readFile(join(scene.product, "package.json"), "utf8"),
  );
  const executable = field(field(manifest, "bin"), "cloving");
  assert.equal(
    scene.fixture.entryPoint,
    join(scene.product, String(executable)),
  );
}

function alive(processId: number): boolean {
  try {
    return process.kill(processId, 0);
  } catch {
    return false;
  }
}

await test(
  "CLV-347 cloving restart in the middle of a 60-second turn starts the new service within 10 seconds, the turn keeps its process, the watch transcript has each line one time, and the turn ends with its result and one cost",
  { timeout: 120_000 },
  () =>
    withTurnHost({ script: lineTurn }, async (scene) => {
      const { fixture } = scene;
      await assertPublicClient(scene);
      const runId = await admittedTurn(fixture, "lines");
      const writing = await writingTurn(scene, runId);
      const before = await call(fixture, {
        operation: "status",
        parameters: {},
      });
      const requested = Date.now();
      const turns = await restartedTurns(fixture, []);
      const invocation: unknown = JSON.parse(
        await readFile(join(fixture.directory, "restart-cli.json"), "utf8"),
      );
      assert.equal(field(invocation, "entryPoint"), fixture.entryPoint);
      assert.deepEqual(field(turns, "connected"), [runId]);
      const after = await call(fixture, {
        operation: "status",
        parameters: {},
      });
      assert.notEqual(after["serviceStartedAt"], before["serviceStartedAt"]);
      const startedAt = Date.parse(String(after["serviceStartedAt"]));
      assert.ok(
        startedAt - requested < 10_000,
        `The new service started ${String(startedAt - requested)} ms after the request.`,
      );
      const { phases, ready } = await replacementPhases({
        output: scene.output,
        requested,
        startedAt,
      });
      console.info("Restart phases:", JSON.stringify(phases));
      assert.ok(ready.at - requested < 10_000);
      assert.equal(
        phases.filter((entry) => entry.phase === "candidate-compiler-start")
          .length,
        0,
      );
      console.info(
        `The new service started ${String(startedAt - requested)} ms after the request.`,
      );
      assert.equal(alive(writing.processId), true);
      const run = await finishedRun(fixture, runId);
      assert.equal(field(run, "state"), "completed", JSON.stringify(run));
      assert.deepEqual(
        assistantTexts(await writing.watch.closed),
        writtenLines(writing.processId),
      );
      assertTurnResult(run);
      const ended = await startedTurn(fixture, runId);
      assert.deepEqual(ended.launch, writing.turn.launch);
    }),
);
