import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import type {
  RestartCancel,
  RestartMark,
  RestartPort,
} from "../src/restart-request.ts";
import { call, startedRun, withHarness } from "./service-fixture.ts";

function memoryPort(): RestartPort {
  let mark: RestartMark | undefined;
  return {
    pending: () => Promise.resolve(mark),
    request: (given) => {
      mark = given;
      return Promise.resolve();
    },
    cancel: () => {
      const state: RestartCancel = mark === undefined ? "none" : "cancelled";
      mark = undefined;
      return Promise.resolve(state);
    },
    unresumable: () =>
      Promise.resolve(mark === undefined ? ["run-shell"] : ["after-request"]),
  };
}

const identity = {
  version: "1.6.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  startedAt: "2026-11-05T10:00:00.000Z",
};

await test("CLV-306 a restart at the next gap stays pending and the status shows it with the active runs", () =>
  withHarness(async (harness) => {
    const service = await harness.start({ restart: memoryPort(), ...identity });
    await startedRun(harness, { service, commandId: "first-run" });
    const before = Date.now();
    const reply = await call(harness, {
      operation: "restart",
      parameters: {
        at: "gap",
        commandId: "restart-one",
        resumeQueue: true,
        settings: "files",
      },
    });
    assert.equal(reply["kind"], "restart", JSON.stringify(reply));
    assert.equal(reply["serviceCommit"], identity.commit);
    assert.equal(reply["serviceStartedAt"], identity.startedAt);
    const restart = record(reply["restart"]) ?? {};
    assert.equal(restart["state"], "pending");
    assert.equal(restart["at"], "gap");
    assert.equal(restart["commandId"], "restart-one");
    assert.equal(restart["activeRuns"], 1);
    const requestedAt = Number(restart["requestedAt"]);
    assert.ok(requestedAt >= before && requestedAt <= Date.now());
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["restart"], {
      at: "gap",
      requestedAt,
      commandId: "restart-one",
      resumeQueue: true,
      settings: "files",
      activeRuns: 1,
    });
    assert.equal(status["serviceVersion"], identity.version);
    assert.equal(status["serviceCommit"], identity.commit);
    assert.equal(status["serviceStartedAt"], identity.startedAt);
  }));

await test("CLV-306 the status shows the source of each setting that the start recorded", () =>
  withHarness(async (harness) => {
    const settingSources = {
      "merge.mode": "environment",
      "queue.lanes": "default",
    } as const;
    await harness.start({ ...identity, settingSources });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["settingSources"], settingSources);
  }));

await test("CLV-306 a restart now lists the runs with a turn that cannot resume before it records the request, and a restart at a gap lists none", () =>
  withHarness(async (harness) => {
    await harness.start({ restart: memoryPort(), ...identity });
    const now = await call(harness, {
      operation: "restart",
      parameters: { at: "now", commandId: "restart-now" },
    });
    assert.deepEqual(record(now["restart"])?.["unresumableRuns"], [
      "run-shell",
    ]);
    const gap = await call(harness, {
      operation: "restart",
      parameters: { at: "gap", commandId: "restart-gap" },
    });
    assert.equal(
      Object.hasOwn(record(gap["restart"]) ?? {}, "unresumableRuns"),
      false,
    );
  }));

await test("CLV-306 a cancel removes a pending restart and a second cancel finds none", () =>
  withHarness(async (harness) => {
    await harness.start({ restart: memoryPort(), ...identity });
    await call(harness, {
      operation: "restart",
      parameters: { at: "now", commandId: "restart-now" },
    });
    const cancelled = await call(harness, {
      operation: "restart",
      parameters: { cancel: true, commandId: "cancel-one" },
    });
    assert.deepEqual(cancelled["restart"], { state: "cancelled" });
    const again = await call(harness, {
      operation: "restart",
      parameters: { cancel: true, commandId: "cancel-two" },
    });
    assert.deepEqual(again["restart"], { state: "none" });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(status["restart"], null);
  }));

await test("CLV-306 the service refuses an invalid restart request and a restart with no restart port", () =>
  withHarness(async (harness) => {
    await harness.start({ restart: memoryPort(), ...identity, commit: null });
    for (const parameters of [
      { at: "later", commandId: "restart-one" },
      { at: "gap" },
      { at: "gap", commandId: "restart-one", cancel: "yes" },
      { at: "gap", commandId: "restart-one", resumeQueue: false },
      { at: "gap", commandId: "restart-one", settings: "shell" },
    ]) {
      const refused = await call(harness, { operation: "restart", parameters });
      assert.equal(refused["code"], "invalid-request", JSON.stringify(refused));
    }
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(status["serviceCommit"], null);
  }));

await test("CLV-306 a service with no restart port refuses a restart", () =>
  withHarness(async (harness) => {
    await harness.start();
    const refused = await call(harness, {
      operation: "restart",
      parameters: { at: "gap", commandId: "restart-one" },
    });
    assert.equal(refused["code"], "restart-unavailable");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(Object.hasOwn(status, "restart"), false);
  }));

await test("CLV-306 a service with no start time refuses a restart, and a cancel shows a restart that already started", () =>
  withHarness(async (harness) => {
    const port: RestartPort = {
      ...memoryPort(),
      cancel: () => Promise.resolve("started"),
    };
    const unknown = await harness.start({ restart: port, commit: null });
    const refused = await call(harness, {
      operation: "restart",
      parameters: { at: "gap", commandId: "restart-one" },
    });
    assert.equal(refused["code"], "restart-unavailable");
    await unknown.close();
    await harness.start({ restart: port, ...identity });
    const started = await call(harness, {
      operation: "restart",
      parameters: { cancel: true, commandId: "cancel-one" },
    });
    assert.deepEqual(started["restart"], { state: "started" });
  }));
