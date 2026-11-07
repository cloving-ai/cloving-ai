import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered } from "../src/cli/render.ts";
import { effectLeaseLimits, queueLimitsOf } from "../src/queue-room.ts";

await test("CLV-322 the effect capacity is the queue lanes plus the reserve, and the queue limit is the lanes", () => {
  assert.deepEqual(
    effectLeaseLimits({ lanes: 4, workingLanes: 4, reserved: 2 }),
    { capacity: 6, queueLimit: 4, reserved: 2 },
  );
  assert.deepEqual(effectLeaseLimits({ lanes: 16, workingLanes: 1 }), {
    capacity: 18,
    queueLimit: 16,
    reserved: 2,
  });
  assert.deepEqual(
    effectLeaseLimits({ lanes: 1, workingLanes: 1, reserved: 0 }),
    { capacity: 1, queueLimit: 1, reserved: 0 },
  );
});

await test("CLV-322 reloaded queue limits keep a reserve from 0 to 8 and refuse other values", () => {
  const limits = { lanes: 2, workingLanes: 2 };
  assert.deepEqual(queueLimitsOf({ ...limits, reserved: 8 }), {
    ...limits,
    reserved: 8,
  });
  assert.deepEqual(queueLimitsOf({ ...limits, reserved: 0 }), {
    ...limits,
    reserved: 0,
  });
  for (const reserved of [9, -1, 1.5, "2", null])
    assert.equal(queueLimitsOf({ ...limits, reserved }), undefined);
});

await test("CLV-322 cloving status shows the effect capacity, the queue limit and the reserve", () => {
  const text = rendered({
    schemaVersion: 1,
    kind: "run-list",
    workflows: [],
    runs: [],
    next: null,
    effectLeases: { capacity: 6, queueLimit: 4, reserved: 2 },
  });
  assert.match(
    text,
    /^Effect leases: capacity 6, 4 for queue runs, 2 reserved for other runs$/m,
  );
  assert.doesNotMatch(
    rendered({
      schemaVersion: 1,
      kind: "run-list",
      workflows: [],
      runs: [],
      next: null,
    }),
    /Effect leases/,
  );
});
