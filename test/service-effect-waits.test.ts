import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectReply } from "../src/service/service.ts";
import {
  effectScene,
  requested,
  shownEffects,
  untilStates,
  type Scene,
} from "./service-effect-fixture.ts";
import { call, field, withHarness } from "./service-fixture.ts";

async function shown(scene: Scene): Promise<readonly unknown[]> {
  return (await shownEffects(scene)).map((effect) => [
    field(effect, "state"),
    field(effect, "reason"),
  ]);
}

async function completed(scene: Scene, admitted: EffectReply): Promise<void> {
  const reply = await scene.service.worker.reportEffect({
    runId: scene.runId,
    commandId: "c-report",
    operationId: String(admitted.operation?.operationId),
    inputDigest: String(admitted.operation?.inputDigest),
    leaseGeneration: 1,
    worker: "worker-1",
    outcome: "completed",
    result: "the result",
  });
  assert.equal(
    reply.disposition?.disposition,
    "applied",
    JSON.stringify(reply),
  );
}

function command(scene: Scene, name: string): Promise<unknown> {
  return call(scene.harness, {
    operation: "run-command",
    parameters: {
      command: name,
      runId: scene.runId,
      expectedRevision: name === "pause" ? 2 : 3,
      commandId: `c-${name}`,
    },
  });
}

await test("CLV-049 status gives the present cause of a wait: after the owner of its resource settles, an operation that still waits shows the capacity as its reason", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, {
      effectLimit: 8,
      effects: { capacity: 2 },
    });
    const shared = { resource: "repository" };
    const owner = await requested(scene, {
      commandId: "c-request-1",
      round: 1,
      ...shared,
    });
    await requested(scene, { commandId: "c-request-2", round: 2 });
    await untilStates(scene, ["running", "running"]);
    await requested(scene, { commandId: "c-request-3", round: 3 });
    await requested(scene, { commandId: "c-request-4", round: 4, ...shared });
    assert.deepEqual(await shown(scene), [
      ["running", null],
      ["running", null],
      ["waiting", "capacity"],
      ["waiting", "resource"],
    ]);
    await completed(scene, owner);
    await untilStates(scene, ["completed", "running", "running", "waiting"]);
    assert.deepEqual((await shown(scene)).at(-1), ["waiting", "capacity"]);
  }));

await test("CLV-049 status gives the present cause of a wait: in a paused run, an operation whose resource is free shows run-not-running, and it runs after the resume", () =>
  withHarness(async (harness) => {
    const scene = await effectScene(harness, { effectLimit: 8 });
    const shared = { resource: "repository" };
    const owner = await requested(scene, {
      commandId: "c-request-1",
      round: 1,
      ...shared,
    });
    await untilStates(scene, ["running"]);
    await requested(scene, { commandId: "c-request-2", round: 2, ...shared });
    await command(scene, "pause");
    await completed(scene, owner);
    assert.deepEqual(await shown(scene), [
      ["completed", null],
      ["waiting", "run-not-running"],
    ]);
    await command(scene, "resume");
    await untilStates(scene, ["completed", "running"]);
  }));
