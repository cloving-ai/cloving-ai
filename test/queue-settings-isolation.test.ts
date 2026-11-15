import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueSettingRequest } from "../src/queue-setting-operation.ts";
import { effectLeaseLimits, roomHold } from "../src/queue-room.ts";
import { queueLimitsSource } from "../src/daemon/queue-limits.ts";
import { reloadQueueSettings } from "../src/daemon/queue-settings-reload.ts";
import {
  declared,
  request,
  settings,
  command,
} from "./queue-settings-reload-fixture.ts";

await test("CLV-377 scoped lane reload preserves actual broker resources, defaults and peer limits", async () => {
  const room = { maxLoadPerCore: 0.7, maxMemoryPressure: "normal" } as const;
  const before = { lanes: 3, workingLanes: 1, reserved: 2, room };
  const peer = { ...before, lanes: 5, workingLanes: 4 };
  const source = queueLimitsSource({
    declarations: [declared, { ...declared, workflowId: "peer" }],
    queueLimits: { ...before, lanes: 4 },
    queueConfigurations: { alpha: { limits: before }, peer: { limits: peer } },
  });
  const digests = {
    queues: "old:old",
    profiles: "old",
    "effects.reserved": "old",
  };
  const pending = {
    ...settings,
    queueLimits: { lanes: 9, workingLanes: 8, reserved: 8 },
    queueWorkflowLimits: {
      alpha: { lanes: 2, workingLanes: 1, reserved: 8 },
      peer: { lanes: 9, workingLanes: 8, reserved: 8 },
    },
  };
  const reply = await reloadQueueSettings({
    command: command(pending),
    declarations: [declared],
    request,
    digests,
    source,
  });
  assert.equal(reply.outcome.kind, "unchanged");
  assert.deepEqual(source.current("alpha"), { ...before, lanes: 2 });
  assert.deepEqual(source.current("peer"), peer);
  assert.deepEqual(source.current("unknown"), { ...before, lanes: 4 });
  assert.deepEqual(effectLeaseLimits(source.current("alpha")), {
    capacity: 4,
    queueLimit: 2,
    reserved: 2,
  });
  assert.deepEqual(reply.digests, digests);
  assert.equal(
    roomHold(
      { loadAverage: 1, cores: 1, memoryPressure: "normal" },
      source.current("alpha").room ?? room,
    )?.reason,
    "load",
  );
  assert.equal(
    roomHold(
      { loadAverage: 0, cores: 1, memoryPressure: "warn" },
      source.current("alpha").room ?? room,
    )?.reason,
    "memory",
  );
});

await test("CLV-377 absent queues and separately changed paired settings refuse without replacing broker limits", async () => {
  const source = queueLimitsSource({
    declarations: [declared],
    queueLimits: { lanes: 3, workingLanes: 1 },
  });
  const before = source.current("alpha");
  for (const queueWorkflowLimits of [
    {},
    { alpha: { lanes: 2, workingLanes: 2 } },
  ]) {
    const reply = await reloadQueueSettings({
      command: command({ ...settings, queueWorkflowLimits }),
      declarations: [declared],
      request,
      digests: {},
      source,
    });
    assert.ok(reply.outcome.kind === "refused");
    assert.match(reply.outcome.detail, /changed separately/);
    assert.deepEqual(source.current("alpha"), before);
  }
});

await test("CLV-377 global digest acknowledgement covers only the selected field and a required atomic adjustment", async () => {
  const { source, digests, pending, sources } = globalDigestScene();
  const global: QueueSettingRequest = {
    ...request,
    scope: "global",
    workflowId: undefined,
    value: 5,
  };
  const raised = await reloadQueueSettings({
    command: command(pending),
    declarations: [],
    request: global,
    digests,
    source,
  });
  assert.deepEqual(raised.digests, { ...digests, "queue.globalLanes": "new" });
  const lowered = {
    ...pending,
    queueLimits: {
      ...pending.queueLimits,
      global: { lanes: 1, workingLanes: 1, sources },
    },
  };
  const adjusted = await reloadQueueSettings({
    command: command(lowered),
    declarations: [],
    request: { ...global, value: 1 },
    digests,
    source,
  });
  assert.deepEqual(adjusted.digests, pending.settingDigests);
  const working = await reloadQueueSettings({
    command: command(lowered),
    declarations: [],
    request: { ...global, field: "workingLanes", value: 1 },
    digests,
    source,
  });
  assert.deepEqual(working.digests, {
    ...digests,
    "queue.globalWorkingLanes": "new",
  });
});

await test("CLV-377 a global lane reload changes only the global cap in every actual broker view", async () => {
  const before = {
    lanes: 3,
    workingLanes: 1,
    reserved: 2,
    global: {
      lanes: 4,
      sources: {
        lanes: "queue setting (private file)",
        workingLanes: "default",
      },
    },
  } as const;
  const source = queueLimitsSource({
    declarations: [declared, { ...declared, workflowId: "peer" }],
    queueLimits: before,
  });
  const next = {
    ...settings,
    queueLimits: {
      lanes: 9,
      workingLanes: 8,
      reserved: 8,
      global: { lanes: 5 },
    },
  };
  const global: QueueSettingRequest = {
    ...request,
    scope: "global",
    workflowId: undefined,
    expectedValue: 4,
    value: 5,
  };
  const reply = await reloadQueueSettings({
    command: command(next),
    declarations: [declared],
    request: global,
    digests: {},
    source,
  });
  assert.equal(reply.outcome.kind, "unchanged");
  for (const id of ["alpha", "peer", "unknown"]) {
    const limits = source.current(id);
    assert.equal(limits.lanes, 3);
    assert.equal(limits.workingLanes, 1);
    assert.deepEqual(effectLeaseLimits(limits), {
      capacity: 5,
      queueLimit: 3,
      reserved: 2,
      queueWorkingLimit: 5,
    });
  }
});

function globalDigestScene() {
  const sources = {
    lanes: "queue setting (private file)",
    workingLanes: "queue setting (private file)",
  } as const;
  const source = queueLimitsSource({
    queueLimits: {
      lanes: 3,
      workingLanes: 1,
      reserved: 2,
      global: { lanes: 4, workingLanes: 2, sources },
    },
  });
  const digests = {
    "queue.globalLanes": "old",
    "queue.globalWorkingLanes": "old",
  };
  const pending = {
    ...settings,
    settingDigests: {
      "queue.globalLanes": "new",
      "queue.globalWorkingLanes": "new",
    },
    queueLimits: {
      lanes: 9,
      workingLanes: 8,
      global: { lanes: 5, workingLanes: 2, sources },
    },
  };
  return { source, digests, pending, sources };
}
