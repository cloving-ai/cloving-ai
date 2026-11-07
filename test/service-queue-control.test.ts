import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueChange, QueuePort } from "../src/queue-state.ts";
import {
  admitted,
  call,
  eventually,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

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
      busyRunIds: [],
      skipped: [],
      state: "stopped",
      stop: { reason: "invalid-ticket-id" },
      failedRunIds: ["run-first"],
      drain: null,
      hold: null,
      holds: [],
      holdsCutAt: null,
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

await test("CLV-309 a start that waits for its ticket reads the lanes again after a reload lowers them", () =>
  withHarness(async (harness) => {
    const lanes = { current: 2 };
    const release = Promise.withResolvers<undefined>();
    const gates = [Promise.resolve(undefined), release.promise];
    const lookups = { count: 0 };
    await harness.start({
      workflows: [
        {
          ...queued(harness),
          queue: true,
          resolver: {
            ...harness.registration.resolver,
            resolve: async () => {
              const gate = gates[lookups.count];
              lookups.count += 1;
              await gate;
              return {
                kind: "resolved",
                input: { cycleId: `cycle-${String(lookups.count)}` },
              };
            },
          },
        },
      ],
      queue: {
        control: () => ({
          failedRunIds: [],
          drain: undefined,
          error: undefined,
          lanes: lanes.current,
        }),
        change: () => Promise.resolve({ kind: "changed" }),
      },
    });
    await admitted(harness, "first-lane");
    const second = call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "second lane" },
        commandId: "second-lane",
      },
    });
    await eventually(() => (lookups.count === 2 ? true : undefined));
    lanes.current = 1;
    release.resolve(undefined);
    const reply = await second;
    assert.equal(reply["code"], "workflow-active");
    assert.equal(reply["commandId"], "second-lane");
  }));
