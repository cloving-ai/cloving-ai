import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedQueueLimits } from "../src/queue-setting-limits.ts";
import type { QueueSettingRequest } from "../src/queue-setting-operation.ts";
import type { QueueLimits } from "../src/queue-room.ts";

const request: QueueSettingRequest = {
  commandId: "edit",
  scope: "workflow",
  workflowId: "alpha",
  field: "lanes",
  action: "set",
  expectedValue: 4,
  value: 6,
};
const privateSources = {
  lanes: "queues setting (private file)",
  workingLanes: "queues setting (private file)",
} as const;

await test("CLV-377 implicit companion reductions keep default-follow provenance despite a matching pending private cap", () => {
  const follows = { ...privateSources, workingLanes: "default" } as const;
  const current: QueueLimits = { lanes: 6, workingLanes: 6, sources: follows };
  const next = { lanes: 4, workingLanes: 4, sources: privateSources };
  const lower = { ...request, expectedValue: 6, value: 4 };
  const workflow = selectedQueueLimits(current, { next, request: lower });
  assert.deepEqual(workflow, { ...current, lanes: 4, workingLanes: 4 });
  assert.deepEqual(
    selectedQueueLimits(
      { lanes: 3, workingLanes: 1, global: { lanes: 6, sources: follows } },
      {
        next: {
          lanes: 3,
          workingLanes: 1,
          global: { lanes: 4, workingLanes: 4, sources: privateSources },
        },
        request: { ...lower, scope: "global", workflowId: undefined },
      },
    ),
    { lanes: 3, workingLanes: 1, global: { lanes: 4, sources: follows } },
  );
  assert.ok(workflow);
  const raised = selectedQueueLimits(workflow, {
    next: { lanes: 5, workingLanes: 5, sources: follows },
    request: { ...request, value: 5 },
  });
  assert.deepEqual(raised, { ...current, lanes: 5, workingLanes: 5 });
});

await test("CLV-377 selected lane pairs preserve lower explicit caps, follow defaults and clamp reductions", () => {
  const before = {
    lanes: 4,
    workingLanes: 2,
    sources: privateSources,
    reserved: 2,
  };
  assert.deepEqual(
    selectedQueueLimits(before, {
      next: { ...before, lanes: 6, reserved: 8 },
      request,
    }),
    { ...before, lanes: 6 },
  );
  const following = {
    ...before,
    workingLanes: 4,
    sources: { ...privateSources, workingLanes: "default" },
  } as const;
  assert.deepEqual(
    selectedQueueLimits(following, {
      next: { ...following, lanes: 6, workingLanes: 6 },
      request,
    }),
    { ...following, lanes: 6, workingLanes: 6 },
  );
  const lower = { ...request, value: 1 };
  assert.deepEqual(
    selectedQueueLimits(before, {
      next: { ...before, lanes: 1, workingLanes: 1 },
      request: lower,
    }),
    { ...before, lanes: 1, workingLanes: 1 },
  );
  assert.deepEqual(
    selectedQueueLimits(before, {
      next: { ...before, workingLanes: 1 },
      request: { ...lower, field: "workingLanes" },
    }),
    { ...before, workingLanes: 1 },
  );
});

await test("CLV-377 separate paired edits and mismatched requested values refuse before application", () => {
  const before = { lanes: 4, workingLanes: 2, sources: privateSources };
  assert.equal(
    selectedQueueLimits(before, {
      next: { ...before, lanes: 6, workingLanes: 3 },
      request,
    }),
    undefined,
  );
  assert.equal(
    selectedQueueLimits(before, {
      next: { ...before, lanes: 6 },
      request: { ...request, field: "workingLanes", value: 2 },
    }),
    undefined,
  );
  assert.equal(
    selectedQueueLimits(before, {
      next: { ...before, lanes: 5 },
      request,
    }),
    undefined,
  );
  assert.equal(
    selectedQueueLimits(before, {
      next: before,
      request: {
        ...request,
        action: "inherit",
        value: undefined,
      },
    }),
    undefined,
  );
});

await test("CLV-377 global resets preserve unrelated configured caps and exact field provenance", () => {
  const current: QueueLimits = {
    lanes: 3,
    workingLanes: 1,
    global: { lanes: 4, workingLanes: 2, sources: privateSources },
  };
  const inherited = {
    ...current,
    global: {
      workingLanes: 2,
      sources: { ...privateSources, lanes: "default" },
    },
  } as const;
  const reset = {
    ...request,
    scope: "global",
    workflowId: undefined,
    action: "inherit",
    value: undefined,
  } as const;
  assert.deepEqual(
    selectedQueueLimits(current, { next: inherited, request: reset }),
    inherited,
  );
  const working = { ...reset, field: "workingLanes" } as const;
  const follows = {
    ...current,
    global: {
      lanes: 4,
      sources: { ...privateSources, workingLanes: "default" },
    },
  } as const;
  assert.deepEqual(
    selectedQueueLimits(current, { next: follows, request: working }),
    follows,
  );
});

await test("CLV-377 global scope preserves an unset cap and refuses a separately changed paired cap", () => {
  const current: QueueLimits = {
    lanes: 3,
    workingLanes: 1,
    global: { lanes: 4, workingLanes: 2, sources: privateSources },
  };
  assert.equal(
    selectedQueueLimits(current, {
      next: { ...current, global: { lanes: 5, workingLanes: 3 } },
      request: { ...request, scope: "global", workflowId: undefined, value: 5 },
    }),
    undefined,
  );
  assert.deepEqual(
    selectedQueueLimits(
      { lanes: 1, workingLanes: 1 },
      {
        next: { lanes: 1, workingLanes: 1, global: { lanes: 6 } },
        request: { ...request, scope: "global", workflowId: undefined },
      },
    ),
    { lanes: 1, workingLanes: 1, global: { lanes: 6 } },
  );
});
