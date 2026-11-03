import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueChange, QueuePort } from "../src/queue-state.ts";
import { call, withHarness, type Harness } from "./service-fixture.ts";

function port(change: QueueChange): QueuePort {
  return {
    control: () => ({
      failedRunIds: ["run-first"],
      drain: undefined,
      error: "invalid-ticket-id",
    }),
    change: () => Promise.resolve(change),
  };
}

function queued(harness: Harness): Harness["registration"] {
  return {
    ...harness.registration,
    manifest: { ...harness.registration.manifest, queue: true },
    admission: 2,
  };
}

const command = (
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> =>
  call(harness, { operation: "queue-command", parameters });

await test("CLV-273 the service refuses a queue command ID that names another command", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [queued(harness)],
      queue: port({ kind: "conflicting-command" }),
    });
    const reply = await command(harness, {
      command: "resume",
      commandId: "drain-one",
    });
    assert.equal(reply["kind"], "error");
    assert.equal(reply["code"], "conflicting-command");
    assert.equal(reply["commandId"], "drain-one");
  }));

await test("CLV-273 the queue read and the status show a queue stopped on an error with its reason", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [queued(harness)],
      queue: port({ kind: "unavailable", detail: "The queue stopped." }),
    });
    const read = await call(harness, { operation: "queue", parameters: {} });
    assert.equal(read["kind"], "queue");
    const queue = read["queue"];
    assert.deepEqual(queue, {
      workflowId: "develop",
      lanes: 2,
      busy: 0,
      skipped: [],
      state: "stopped",
      stop: { reason: "invalid-ticket-id" },
      failedRunIds: ["run-first"],
      drain: null,
    });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["queue"], queue);
    const refused = await command(harness, {
      command: "drain",
      commandId: "drain-late",
    });
    assert.equal(refused["code"], "queue-unavailable");
    assert.equal(refused["detail"], "The queue stopped.");
    assert.equal(refused["commandId"], "drain-late");
  }));

await test("CLV-273 the service refuses invalid queue commands and a service with no queue", () =>
  withHarness(async (harness) => {
    await harness.start();
    for (const parameters of [
      { command: "pause", commandId: "one" },
      { command: "drain" },
    ]) {
      const reply = await command(harness, parameters);
      assert.equal(reply["code"], "invalid-request");
    }
    const read = await call(harness, { operation: "queue", parameters: {} });
    assert.equal(read["code"], "queue-unavailable");
    const change = await command(harness, {
      command: "drain",
      commandId: "one",
    });
    assert.equal(change["code"], "queue-unavailable");
  }));
