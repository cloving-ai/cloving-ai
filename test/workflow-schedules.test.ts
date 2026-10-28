import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowDeclaration } from "../src/workflow-declaration.ts";
import {
  checkWorkflowSchedule,
  configuredSchedules,
  parseSchedulesSetting,
} from "../src/workflow-schedule.ts";

const declaration = {
  workflowId: "review-queue",
  effectLimit: 1,
  capabilities: ["claude"],
  input: {
    maximumBytes: 128,
    fields: { page: { type: "integer", minimum: 1 } },
  },
} as const;

await test("CLV-179 declarations accept bounded schedules with contract-checked input", () => {
  for (const everySeconds of [60, 300, 86400])
    assert.ok(
      isWorkflowDeclaration({
        ...declaration,
        schedule: { everySeconds, input: { page: 1 } },
      }),
    );
});

await test("CLV-179 declarations reject malformed schedules and mismatched input", () => {
  for (const schedule of [
    null,
    undefined,
    [],
    {},
    { everySeconds: 300 },
    { everySeconds: 300, input: {} },
    { everySeconds: 300, input: { page: 0 } },
    { everySeconds: 300, input: { page: "1" } },
    { everySeconds: 300, input: { page: 1, extra: true } },
    { everySeconds: 300, input: { page: 1 }, extra: true },
    ...[0, 59, 86401, 60.5, NaN, Infinity, "300"].map((everySeconds) => ({
      everySeconds,
      input: { page: 1 },
    })),
  ])
    assert.equal(isWorkflowDeclaration({ ...declaration, schedule }), false);
});

await test("CLV-179 schedule refusals use fixed interval and input codes", () => {
  for (const everySeconds of [59, 86401, 60.5])
    assert.deepEqual(
      checkWorkflowSchedule(declaration.input, {
        everySeconds,
        input: { page: 1 },
      }),
      { kind: "rejected", code: "invalid-schedule-interval" },
    );
  for (const input of [
    null,
    {},
    { page: 0 },
    { page: 1, extra: "x".repeat(150) },
  ])
    assert.deepEqual(
      checkWorkflowSchedule(declaration.input, { everySeconds: 300, input }),
      { kind: "rejected", code: "invalid-schedule-input" },
    );
});

await test("CLV-179 settings parse JSON and refuse malformed or unknown schedules", () => {
  assert.deepEqual(parseSchedulesSetting(undefined), {});
  assert.deepEqual(
    parseSchedulesSetting(
      '{"review-queue":{"everySeconds":60,"input":{"page":2}}}',
    ),
    { "review-queue": { everySeconds: 60, input: { page: 2 } } },
  );
  assert.throws(() => parseSchedulesSetting("["), /invalid-schedules/);
  for (const overrides of [null, [], 1])
    assert.throws(
      () => configuredSchedules([declaration], overrides),
      /invalid-schedules/,
    );
  assert.throws(
    () =>
      configuredSchedules([declaration], {
        absent: { everySeconds: 60, input: {} },
      }),
    /unknown-schedule-workflow/,
  );
  assert.throws(
    () =>
      configuredSchedules([declaration], {
        "review-queue": { everySeconds: 1, input: {} },
      }),
    /invalid-schedule-interval/,
  );
  assert.throws(
    () =>
      configuredSchedules([declaration], {
        "review-queue": { everySeconds: 60, input: {} },
      }),
    /invalid-schedule-input/,
  );
});

await test("CLV-179 settings replace declared schedules and can add one to an unscheduled declaration", () => {
  const original = { everySeconds: 300, input: { page: 1 } };
  const override = { everySeconds: 60, input: { page: 2 } };
  assert.deepEqual(configuredSchedules([declaration], {}), {});
  assert.deepEqual(
    configuredSchedules([{ ...declaration, schedule: original }], {}),
    { "review-queue": original },
  );
  for (const source of [declaration, { ...declaration, schedule: original }])
    assert.deepEqual(
      configuredSchedules([source], { "review-queue": override }),
      { "review-queue": override },
    );
});

await test("CLV-179 schedules retain command declarations and their validation", () => {
  const scheduled = {
    ...declaration,
    capabilities: ["command"],
    commands: ["scan"],
    handoffs: ["review-queue"],
    schedule: { everySeconds: 300, input: { page: 1 } },
  };
  assert.ok(isWorkflowDeclaration(scheduled));
  assert.equal(isWorkflowDeclaration({ ...scheduled, commands: [] }), false);
  assert.equal(
    isWorkflowDeclaration({ ...scheduled, handoffs: ["bad/id"] }),
    false,
  );
});
