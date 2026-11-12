import assert from "node:assert/strict";
import { test } from "node:test";
import {
  queueLanes,
  queueLimits,
  queuePlan,
} from "../tools/self-host-queue.ts";

const queue = { CLOVING_QUEUE_SECONDS: "10" };

await test("CLV-359 a constructor queue without its own setting or ticket commands leaves the service without a queue", () => {
  const configuration = {
    declarations: [{ workflowId: "constructor", queue: true }],
    sources: {},
  };
  for (const setting of [undefined, "{}", '{"other":{"lanes":2}}'])
    assert.deepEqual(queuePlan({ CLOVING_QUEUES: setting }, configuration), {
      kind: "none",
    });
  assert.throws(
    () => queuePlan({ CLOVING_QUEUES: '{"constructor":{}}' }, configuration),
    { message: "The daemon did not start: queue-needs-next-command" },
  );
  assert.deepEqual(
    queuePlan(
      { CLOVING_QUEUES: '{"constructor":{"state":"off"}}' },
      configuration,
    ),
    { kind: "off", workflowId: "constructor" },
  );
});

await test("CLV-309 queue lanes take a whole number from 1 to 16", () => {
  assert.equal(queueLanes({ ...queue, CLOVING_QUEUE_LANES: "16" }), 16);
  for (const value of ["0", "17", "2.5", "", "1e1", "-1"])
    assert.throws(() => queueLanes({ ...queue, CLOVING_QUEUE_LANES: value }), {
      message: "The daemon did not start: invalid-queue-lanes",
    });
});

await test("CLV-309 the queue limits default to the lanes, a load of 0.7 and the normal pressure", () => {
  assert.deepEqual(queueLimits({ ...queue, CLOVING_QUEUE_LANES: "3" }), {
    lanes: 3,
    workingLanes: 3,
    room: { maxLoadPerCore: 0.7, maxMemoryPressure: "normal" },
  });
  assert.deepEqual(queueLimits({}), {
    lanes: 1,
    workingLanes: 1,
    room: { maxLoadPerCore: 0.7, maxMemoryPressure: "normal" },
  });
});

await test("CLV-309 the queue limits read the working lanes, the load limit and the pressure limit", () => {
  assert.deepEqual(
    queueLimits({
      ...queue,
      CLOVING_QUEUE_LANES: "6",
      CLOVING_QUEUE_WORKING_LANES: "3",
      CLOVING_QUEUE_MAX_LOAD_PER_CORE: "1.25",
      CLOVING_QUEUE_MAX_MEMORY_PRESSURE: "warn",
    }),
    {
      lanes: 6,
      workingLanes: 3,
      room: { maxLoadPerCore: 1.25, maxMemoryPressure: "warn" },
    },
  );
  for (const value of ["0.1", "4"])
    assert.equal(
      queueLimits({ ...queue, CLOVING_QUEUE_MAX_LOAD_PER_CORE: value }).room
        ?.maxLoadPerCore,
      Number(value),
    );
});

await test("CLV-309 the queue limits refuse values outside their ranges", () => {
  const refused = (environment: Record<string, string>, code: string) => {
    assert.throws(() => queueLimits({ ...queue, ...environment }), {
      message: `The daemon did not start: ${code}`,
    });
  };
  for (const value of ["0.09", "4.01", "", "text", "1e0", "-1", ".5"])
    refused(
      { CLOVING_QUEUE_MAX_LOAD_PER_CORE: value },
      "invalid-queue-max-load-per-core",
    );
  for (const value of ["critical", "", "Normal"])
    refused(
      { CLOVING_QUEUE_MAX_MEMORY_PRESSURE: value },
      "invalid-queue-max-memory-pressure",
    );
  for (const value of ["0", "17", "1.5", ""])
    refused(
      { CLOVING_QUEUE_WORKING_LANES: value },
      "invalid-queue-working-lanes",
    );
  refused(
    { CLOVING_QUEUE_LANES: "2", CLOVING_QUEUE_WORKING_LANES: "3" },
    "invalid-queue-working-lanes",
  );
});

await test("CLV-309 the new queue limits need a queue interval", () => {
  for (const [name, value, code] of [
    ["CLOVING_QUEUE_WORKING_LANES", "1", "queue-working-lanes-needs-queue"],
    ["CLOVING_QUEUE_MAX_LOAD_PER_CORE", "1", "queue-max-load-needs-queue"],
    [
      "CLOVING_QUEUE_MAX_MEMORY_PRESSURE",
      "warn",
      "queue-max-memory-needs-queue",
    ],
  ] as const)
    assert.throws(() => queueLimits({ [name]: value }), {
      message: `The daemon did not start: ${code}`,
    });
});

await test("CLV-322 the effect reserve takes a whole number from 0 to 8 with or without a queue", () => {
  assert.equal(queueLimits({ CLOVING_EFFECT_RESERVED: "0" }).reserved, 0);
  assert.equal(
    queueLimits({ ...queue, CLOVING_EFFECT_RESERVED: "8" }).reserved,
    8,
  );
  assert.equal(queueLimits({}).reserved, undefined);
  for (const value of ["9", "-1", "2.5", "", "1e1", "two"])
    assert.throws(() => queueLimits({ CLOVING_EFFECT_RESERVED: value }), {
      message: "The daemon did not start: invalid-effect-settings",
    });
});
