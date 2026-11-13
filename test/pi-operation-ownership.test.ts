import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  record,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { fakePi } from "./pi-fixture.ts";
import { operationFile } from "./harness-detached-fixture.ts";

const signal = new AbortController().signal;
const foreign = intent({ target: "ticket/foreign" });

async function ownedTurn(scene: Scene) {
  const gate = join(scene.directory, "release");
  const settings = { harness: { name: "pi", path: fakePi(scene, { gate }) } };
  const worker = scene.worker("unused", settings);
  await worker.deliver(intent(), signal);
  await until(() => existsSync(join(scene.directory, "observed.json")));
  const started = record(scene, "operation-1/started.json");
  const processId = Number(field(field(started, "launch"), "processId"));
  return { worker, settings, gate, started, processId };
}

async function recoveringTurn(
  scene: Scene,
  settings: Awaited<ReturnType<typeof ownedTurn>>["settings"],
) {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const next = scene.worker("unused", {
    ...settings,
    document: async () => {
      entered.resolve(undefined);
      await released.promise;
      return "original prompt";
    },
  });
  const recovery = next.reconcile(intent(), signal);
  await entered.promise;
  return { next, recovery, released };
}

function refused(reply: unknown): void {
  assert.equal(field(reply, "kind"), "unknown");
  assert.match(
    String(field(reply, "evidence")),
    /pi-session-ownership-conflict/,
  );
}

await test("CLV-365 an active Pi turn refuses a foreign target before returning its receipt", () =>
  withScene(async (scene) => {
    const { worker, gate, processId, started } = await ownedTurn(scene);
    refused(await worker.reconcile(foreign, signal));
    assert.equal(alive(processId), true);
    assert.deepEqual(record(scene, "operation-1/started.json"), started);
    assert.equal(scene.turns().length, 1);
    assert.equal((await worker.reconcile(intent(), signal)).kind, "accepted");
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

await test("CLV-365 an active Pi owner refuses a foreign receipt when its start record is lost", () =>
  withScene(async (scene) => {
    const { worker, gate, processId } = await ownedTurn(scene);
    rmSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "started.json",
      }),
    );
    refused(await worker.reconcile(foreign, signal));
    assert.equal(alive(processId), true);
    assert.equal(scene.turns().length, 1);
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

await test("CLV-365 a completed Pi turn refuses a foreign target before replaying its result", () =>
  withScene(async (scene) => {
    const { worker, settings, gate } = await ownedTurn(scene);
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    const result = record(scene, "operation-1/result.json");
    const next = scene.worker("unused", settings);
    refused(await worker.reconcile(foreign, signal));
    refused(await next.reconcile(foreign, signal));
    assert.equal((await next.reconcile(intent(), signal)).kind, "completed");
    assert.deepEqual(record(scene, "operation-1/result.json"), result);
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports.length, 1);
  }));

await test("CLV-365 concurrent Pi recovery cannot share a receipt with a foreign target", () =>
  withScene(async (scene) => {
    const { worker, settings, gate, processId } = await ownedTurn(scene);
    await worker.close({ turns: "keep" });
    const { next, recovery, released } = await recoveringTurn(scene, settings);
    const conflicting = next.reconcile(foreign, signal);
    released.resolve(undefined);
    refused(await conflicting);
    assert.equal((await recovery).kind, "accepted");
    assert.equal(alive(processId), true);
    assert.equal(scene.turns().length, 1);
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
  }));

await test("CLV-365 drop refuses a foreign Pi target without stopping the owned process", () =>
  withScene(async (scene) => {
    const { worker, processId, gate, started } = await ownedTurn(scene);
    refused(await worker.stop(foreign, signal));
    assert.equal(alive(processId), true);
    assert.deepEqual(record(scene, "operation-1/started.json"), started);
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    assert.equal(scene.reports.length, 0);
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-365 a foreign Pi drop during recovery cannot stop the recovered owner", () =>
  withScene(async (scene) => {
    const { worker, settings, gate, processId } = await ownedTurn(scene);
    await worker.close({ turns: "keep" });
    const { next, recovery, released } = await recoveringTurn(scene, settings);
    const drop = next.stop(foreign, signal);
    released.resolve(undefined);
    assert.equal((await recovery).kind, "accepted");
    refused(await drop);
    assert.equal(alive(processId), true);
    assert.equal(scene.reports.length, 0);
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-365 a completed Pi drop refuses a foreign target without returning its result", () =>
  withScene(async (scene) => {
    const { worker, gate } = await ownedTurn(scene);
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    const result = record(scene, "operation-1/result.json");
    refused(await worker.stop(foreign, signal));
    assert.deepEqual(record(scene, "operation-1/result.json"), result);
    assert.equal((await worker.stop(intent(), signal)).kind, "completed");
    assert.equal(scene.reports.length, 1);
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-365 the owned Pi drop waits for recovery and process exit without another prompt", () =>
  withScene(async (scene) => {
    const { worker, settings, processId } = await ownedTurn(scene);
    await worker.close({ turns: "keep" });
    const { next, recovery, released } = await recoveringTurn(scene, settings);
    const drop = next.stop(intent(), signal);
    released.resolve(undefined);
    assert.equal((await recovery).kind, "accepted");
    assert.equal((await drop).kind, "stopped");
    assert.equal(alive(processId), false);
    assert.equal(scene.reports.length, 1);
    assert.equal(scene.reports[0]?.outcome, "stopped");
    assert.equal(scene.turns().length, 1);
    assert.equal((await next.reconcile(intent(), signal)).kind, "stopped");
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-365 a foreign Pi drop refuses before joining an owned recovery queue", () =>
  withScene(async (scene) => {
    const { worker, settings, gate, processId } = await ownedTurn(scene);
    await worker.close({ turns: "keep" });
    const { next, recovery, released } = await recoveringTurn(scene, settings);
    let answer: unknown;
    const drop = next.stop(foreign, signal).then((reply) => {
      answer = reply;
    });
    try {
      await until(() => answer !== undefined);
      refused(answer);
      assert.equal(alive(processId), true);
    } finally {
      released.resolve(undefined);
      await Promise.all([recovery, drop]);
    }
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 1);
  }));
