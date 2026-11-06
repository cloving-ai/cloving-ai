import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { scheduleConnection } from "../src/daemon/schedule-control.ts";
import { workflowSchedules } from "../src/daemon/workflow-schedules.ts";
import { scheduledWorkflow } from "./workflow-scheduler-fixture.ts";
import { withHarness, parsed, type Harness } from "./service-fixture.ts";

async function withSchedule(
  body: (harness: Harness) => Promise<void>,
  scheduling = { declarations: [scheduledWorkflow], clock: 0 },
): Promise<void> {
  await withHarness(async (harness) => {
    await mkdir(join(harness.stateDirectory, "state"));
    const connection = scheduleConnection();
    await harness.start({ schedule: connection.request });
    const scheduler = await workflowSchedules({
      directory: harness.stateDirectory,
      runtimeDirectory: harness.runtimeDirectory,
      declarations: scheduling.declarations,
      scheduleClock: () => scheduling.clock,
      submit: () =>
        Promise.resolve({ kind: "accepted", sequence: 1, intents: [] }),
    });
    connection.connect(scheduler.request);
    try {
      await body(harness);
    } finally {
      await scheduler.stop();
    }
  });
}

await test("CLV-242 schedule CLI lists text and JSON state", () =>
  withSchedule(async (harness) => {
    const plain = await harness.cli(["schedule"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(
      plain.stdout,
      /review.*300.*active.*1970-01-01T00:05:00.000Z.*0/s,
    );
    const json = await harness.cli(["schedule", "--json"]);
    assert.equal(json.status, 0, json.stdout);
    const result = parsed(json);
    assert.equal(result["kind"], "schedules");
    assert.deepEqual(result["schedules"], [
      {
        workflowId: "review",
        everySeconds: 300,
        state: "active",
        failuresInRow: 0,
        failedRunIds: [],
        lastSlot: 0,
        nextAt: 300000,
        activeRunId: null,
        stoppedAt: null,
        stoppedSlot: null,
        stops: [],
      },
    ]);
  }));

await test("CLV-314 schedule and status show a calendar schedule and its next run with the offset", () =>
  withSchedule(
    async (harness) => {
      const plain = await harness.cli(["schedule"]);
      assert.equal(plain.status, 0, plain.stderr);
      assert.match(
        plain.stdout,
        /^ {2}review {2}Mondays at 07:00 America\/Los_Angeles {2}active {2}next 2026-11-16T07:00:00-08:00 /m,
      );
      const status = await harness.cli(["status"]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(
        status.stdout,
        /^Schedule review: Mondays at 07:00 America\/Los_Angeles, active, next run at 2026-11-16T07:00:00-08:00, 0 failures in a row$/m,
      );
      const json = await harness.cli(["status", "--json"]);
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(parsed(json)["schedules"], [
        {
          workflowId: "review",
          at: "07:00",
          timeZone: "America/Los_Angeles",
          weekdays: ["monday"],
          state: "active",
          failuresInRow: 0,
          nextAt: Date.parse("2026-11-16T07:00:00-08:00"),
          nextLocal: "2026-11-16T07:00:00-08:00",
          stoppedAt: null,
        },
      ]);
    },
    {
      declarations: [
        {
          ...scheduledWorkflow,
          schedule: {
            at: "07:00",
            timeZone: "America/Los_Angeles",
            weekdays: ["monday"],
            input: { prompt: "current" },
          },
        },
      ],
      clock: Date.parse("2026-11-10T06:00:00-08:00"),
    },
  ));

await test("CLV-242 schedule CLI pauses and resumes in text and JSON", () =>
  withSchedule(async (harness) => {
    for (const action of ["pause", "resume"]) {
      const plain = await harness.cli(["schedule", action, "review"]);
      assert.equal(plain.status, 0, plain.stderr);
      assert.match(
        plain.stdout,
        new RegExp(`review.*${action === "pause" ? "paused" : "active"}`, "s"),
      );
      const json = await harness.cli(["schedule", action, "review", "--json"]);
      assert.equal(json.status, 0, json.stdout);
      assert.equal(parsed(json)["kind"], "schedule");
    }
  }));

await test("CLV-242 schedule CLI reports unknown schedules and unavailable scheduling", () =>
  withSchedule(async (harness) => {
    for (const action of ["pause", "resume"]) {
      const plain = await harness.cli(["schedule", action, "missing"]);
      assert.equal(plain.status, 1);
      assert.match(plain.stderr, /unknown-schedule/);
      const json = await harness.cli(["schedule", action, "missing", "--json"]);
      assert.equal(json.status, 1);
      assert.equal(parsed(json)["code"], "unknown-schedule");
    }
  }));

await test("CLV-242 schedule CLI preserves the service unavailable refusal", () =>
  withHarness(async (harness) => {
    await harness.start();
    const plain = await harness.cli(["schedule"]);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /schedules-unavailable/);
    const json = await harness.cli(["schedule", "--json"]);
    assert.equal(parsed(json)["code"], "schedules-unavailable");
  }));

await test("CLV-242 schedule arguments reject invalid actions, IDs and extra values", () => {
  for (const args of [
    ["pause"],
    ["resume", ""],
    ["stop", "review"],
    ["pause", "review", "extra"],
    ["pause", "bad\nname"],
    ["--limit", "2"],
    ["--json", "--json"],
  ]) {
    assert.equal(
      parseInvocation(["schedule", ...args]).kind,
      "usage-error",
      JSON.stringify(args),
    );
  }
});
