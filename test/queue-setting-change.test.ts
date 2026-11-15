import assert from "node:assert/strict";
import { test } from "node:test";
import { changedQueueSettingConfiguration } from "../src/queue-setting-change.ts";
import { parseConfiguration } from "../src/project-settings.ts";
import {
  queueSettingRequest,
  type QueueSettingRequest,
} from "../src/queue-setting-operation.ts";

const base: QueueSettingRequest = {
  commandId: "change",
  scope: "workflow",
  workflowId: "alpha",
  field: "lanes",
  action: "set",
  expectedValue: 4,
  value: 2,
};
const previous = {
  version: 1,
  queue: { lanes: 4, globalLanes: 8 },
  queues: {
    alpha: { lanes: 4, workingLanes: 3, everySeconds: 120 },
    beta: { lanes: 5 },
  },
  merge: { mode: "queue" },
};

function configured(
  request: QueueSettingRequest,
  setup: {
    readonly contents?: unknown;
    readonly project?: unknown;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly declaredLanes?: number;
  },
) {
  return parseConfiguration(
    changedQueueSettingConfiguration(JSON.stringify(setup.contents), {
      scope: "private",
      queueSetting: {
        request,
        environment: setup.environment ?? {},
        declaredLanes: setup.declaredLanes ?? 1,
        ...(setup.project === undefined
          ? {}
          : { project: JSON.stringify(setup.project) }),
      },
    }),
    "private",
  );
}

await test("CLV-377 advanced workflow caps set and inherit only their private field while current project defaults survive", () => {
  const set = changed({
    ...base,
    field: "workingLanes",
    expectedValue: 3,
    value: 2,
  });
  assert.deepEqual(set.queues?.["alpha"], {
    lanes: 4,
    workingLanes: 2,
    everySeconds: 120,
  });
  const reset = configured(
    {
      ...base,
      field: "workingLanes",
      expectedValue: 3,
      action: "inherit",
      value: undefined,
    },
    { contents: previous, project: { version: 1, queue: { workingLanes: 2 } } },
  );
  assert.deepEqual(reset.queues?.["alpha"], { lanes: 4, everySeconds: 120 });
  assert.deepEqual(reset.queues["beta"], previous.queues.beta);
});

await test("CLV-377 global work caps support independent activation and inherit a project cap without editing total lanes", () => {
  const request: QueueSettingRequest = {
    commandId: "global-work",
    scope: "global",
    field: "workingLanes",
    action: "set",
    expectedValue: 16,
    value: 2,
  };
  assert.deepEqual(configured(request, {}).queue, { globalWorkingLanes: 2 });
  const reset = configured(
    { ...request, action: "inherit", expectedValue: 2, value: undefined },
    {
      contents: {
        version: 1,
        queue: { globalLanes: 4, globalWorkingLanes: 2 },
      },
      project: { version: 1, queue: { globalWorkingLanes: 3 } },
    },
  );
  assert.deepEqual(reset.queue, { globalLanes: 4 });
});

await test("CLV-377 invalid inherited pairs and environment work overrides refuse before producing a configuration", () => {
  assert.throws(
    () =>
      configured(
        { ...base, field: "workingLanes", expectedValue: 3, value: 5 },
        { contents: previous },
      ),
    /active-work cap exceeds/,
  );
  assert.throws(
    () =>
      configured(
        {
          commandId: "global",
          scope: "global",
          field: "lanes",
          expectedValue: 4,
          action: "set",
          value: 2,
        },
        {
          contents: { version: 1, queue: { globalLanes: 4 } },
          environment: { CLOVING_QUEUE_GLOBAL_WORKING_LANES: "3" },
        },
      ),
    /CLOVING_QUEUE_GLOBAL_WORKING_LANES controls/,
  );
  assert.throws(
    () =>
      configured(
        { ...base, expectedValue: 1 },
        { environment: { CLOVING_QUEUE_WORKING_LANES: "invalid" } },
      ),
    /environment override.*invalid/,
  );
  assert.throws(
    () => configured({ ...base, value: 17 }, {}),
    /request is invalid/,
  );
});

await test("CLV-377 unset private configuration follows the current declaration and a concurrent identical value remains valid", () => {
  assert.deepEqual(
    configured({ ...base, expectedValue: 2, value: 3 }, { declaredLanes: 2 }),
    { version: 1, queues: { alpha: { lanes: 3 } } },
  );
  assert.deepEqual(
    configured(
      { ...base, value: 2 },
      { contents: { version: 1, queues: { alpha: { lanes: 2 } } } },
    ).queues?.["alpha"],
    { lanes: 2 },
  );
});

function changed(request: QueueSettingRequest, contents: unknown = previous) {
  return parseConfiguration(
    changedQueueSettingConfiguration(JSON.stringify(contents), {
      scope: "private",
      queueSetting: { request, environment: {}, declaredLanes: 1 },
    }),
    "private",
  );
}

await test("CLV-377 the narrow setting operation adjusts only its workflow pair and resets only its private numeric overrides", () => {
  const reduced = changed(base);
  assert.deepEqual(reduced, {
    ...previous,
    queues: {
      ...previous.queues,
      alpha: { lanes: 2, workingLanes: 2, everySeconds: 120 },
    },
  });
  const reset = changed({ ...base, action: "inherit", value: undefined });
  assert.deepEqual(reset, {
    ...previous,
    queues: {
      ...previous.queues,
      alpha: { everySeconds: 120, workingLanes: 3 },
    },
  });
});

await test("CLV-377 an explicit global cap changes atomically without changing general defaults or workflow overrides", () => {
  const request: QueueSettingRequest = {
    commandId: "global",
    scope: "global",
    field: "lanes",
    action: "set",
    expectedValue: 8,
    value: 2,
  };
  const result = changed(request, {
    ...previous,
    queue: { ...previous.queue, globalWorkingLanes: 3 },
  });
  assert.deepEqual(result, {
    ...previous,
    queue: { ...previous.queue, globalLanes: 2, globalWorkingLanes: 2 },
  });
});

await test("CLV-377 malformed setting operations cannot choose fields, paths or non-workflow targets", () => {
  assert.deepEqual(queueSettingRequest(base), base);
  for (const patch of [
    { value: 0 },
    { value: 17 },
    { value: "3" },
    { expectedValue: 0 },
    { field: "harness.command" },
    { path: "config.json" },
    { workflowId: "../other" },
    { scope: "global" },
  ])
    assert.equal(
      queueSettingRequest({ ...base, ...patch }),
      undefined,
      JSON.stringify(patch),
    );
});

await test("CLV-377 higher-priority queue environment settings refuse before creating hidden private edits", () => {
  for (const request of [
    base,
    { ...base, scope: "global" as const, workflowId: undefined },
  ]) {
    assert.throws(
      () =>
        changedQueueSettingConfiguration(JSON.stringify(previous), {
          scope: "private",
          queueSetting: {
            request,
            environment: {
              CLOVING_QUEUES: '{"alpha":{"lanes":4}}',
              CLOVING_QUEUE_GLOBAL_LANES: "8",
            },
          },
        }),
      /environment|override/,
    );
  }
});

await test("CLV-377 an old pending intent cannot overwrite a newer CLI lane edit inside the settings lock", () => {
  assert.throws(
    () =>
      changed(base, {
        ...previous,
        queues: { ...previous.queues, alpha: { lanes: 5, workingLanes: 2 } },
      }),
    /changed.*Refresh/,
  );
});

await test("CLV-377 inheriting total lanes preserves an explicit lower active-work cap", () => {
  const result = changed(
    { ...base, action: "inherit", value: undefined },
    {
      ...previous,
      queue: { lanes: 6 },
      queues: { alpha: { lanes: 4, workingLanes: 2 } },
    },
  );
  assert.deepEqual(result.queues?.["alpha"], { workingLanes: 2 });
  const global = changed(
    {
      commandId: "inherit-global",
      scope: "global",
      action: "inherit",
      field: "lanes",
      expectedValue: 8,
    },
    { version: 1, queue: { globalLanes: 8, globalWorkingLanes: 2 } },
  );
  assert.deepEqual(global.queue, { globalWorkingLanes: 2 });
});
