import assert from "node:assert/strict";
import { keptDigests, settingChanges } from "../src/daemon/settings-reload.ts";
import { test } from "node:test";
import {
  parseQueuesSetting,
  queueValues,
  type GeneralQueueValues,
} from "../src/queue-settings.ts";

const general: GeneralQueueValues = {
  everySeconds: { value: 30, source: "queue setting" },
  lanes: { value: 3, source: "environment" },
};

await test("CLV-359 a mixed queues edit reports both the applied limits and the restart fields", () => {
  assert.deepEqual(
    settingChanges(
      { queues: "restart-a:lanes-a" },
      { queues: "restart-b:lanes-b" },
    ),
    { reloadedFields: ["queues"], restartFields: ["queues"] },
  );
});

await test("CLV-359 a mixed queues reload retains the active restart digest and the new limits digest", () => {
  const next = { queues: "restart-b:lanes-b" };
  const kept = keptDigests(
    { queues: "restart-a:lanes-a" },
    { digests: next, reloadedFields: ["queues"] },
  );
  assert.deepEqual(kept, { queues: "restart-a:lanes-b" });
  assert.deepEqual(settingChanges(kept, next), {
    reloadedFields: [],
    restartFields: ["queues"],
  });
  assert.deepEqual(settingChanges(kept, { queues: "restart-a:lanes-b" }), {
    reloadedFields: [],
    restartFields: [],
  });
  assert.deepEqual(settingChanges(kept, { queues: "restart-a:lanes-a" }), {
    reloadedFields: ["queues"],
    restartFields: [],
  });
});

await test("CLV-359 the queues setting comes first for the lanes and the interval", () => {
  assert.deepEqual(
    queueValues({
      declared: { everySeconds: 300, lanes: 2 },
      setting: { everySeconds: 600, lanes: 4 },
      general,
    }),
    {
      everySeconds: { value: 600, source: "queues setting" },
      lanes: { value: 4, source: "queues setting" },
      workingLanes: { value: 4, source: "default" },
    },
  );
});

await test("CLV-359 the queue setting or the environment comes before the declaration", () => {
  assert.deepEqual(
    queueValues({
      declared: { everySeconds: 300, lanes: 2 },
      setting: { state: "on" },
      general,
    }),
    {
      everySeconds: { value: 30, source: "queue setting" },
      lanes: { value: 3, source: "environment" },
      workingLanes: { value: 3, source: "default" },
    },
  );
});

await test("CLV-359 the declaration comes before the defaults", () => {
  assert.deepEqual(
    queueValues({ declared: { everySeconds: 300, lanes: 2 }, general: {} }),
    {
      everySeconds: { value: 300, source: "declaration" },
      lanes: { value: 2, source: "declaration" },
      workingLanes: { value: 2, source: "default" },
    },
  );
});

await test("CLV-359 a queue with no values takes 120 seconds and one lane", () => {
  assert.deepEqual(queueValues({ declared: {}, general: {} }), {
    everySeconds: { value: 120, source: "default" },
    lanes: { value: 1, source: "default" },
    workingLanes: { value: 1, source: "default" },
  });
});

await test("CLV-359 the working lanes come from the queues setting, then the queue setting, then the lanes", () => {
  const declared = { lanes: 4 };
  assert.deepEqual(
    queueValues({
      declared,
      setting: { workingLanes: 2 },
      general: { workingLanes: { value: 3, source: "environment" } },
    }).workingLanes,
    { value: 2, source: "queues setting" },
  );
  assert.deepEqual(
    queueValues({
      declared,
      general: { workingLanes: { value: 3, source: "queue setting" } },
    }).workingLanes,
    { value: 3, source: "queue setting" },
  );
  assert.throws(
    () =>
      queueValues({
        declared,
        setting: { lanes: 2 },
        general: { workingLanes: { value: 3, source: "environment" } },
      }),
    { message: "invalid-queue-working-lanes" },
  );
});

await test("CLV-359 the queues setting maps workflow IDs to a state and bounded whole numbers", () => {
  assert.deepEqual(parseQueuesSetting(undefined), {});
  assert.deepEqual(
    parseQueuesSetting(
      JSON.stringify({
        develop: { state: "off", everySeconds: 10, lanes: 16, workingLanes: 1 },
        other: {},
      }),
    ),
    {
      develop: { state: "off", everySeconds: 10, lanes: 16, workingLanes: 1 },
      other: {},
    },
  );
  for (const value of [
    "[]",
    "text",
    '{"develop":{"state":"paused"}}',
    '{"develop":{"state":""}}',
    '{"develop":{"everySeconds":9}}',
    '{"develop":{"everySeconds":3601}}',
    '{"develop":{"lanes":0}}',
    '{"develop":{"lanes":17}}',
    '{"develop":{"workingLanes":1.5}}',
    '{"develop":{"lanes":2,"workingLanes":3}}',
    '{"develop":{"interval":10}}',
    '{"develop":[]}',
    '{"../develop":{}}',
  ])
    assert.throws(() => parseQueuesSetting(value), {
      message: "invalid-setting: queues",
    });
});
