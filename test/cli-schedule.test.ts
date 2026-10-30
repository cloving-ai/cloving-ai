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
): Promise<void> {
  await withHarness(async (harness) => {
    await mkdir(join(harness.stateDirectory, "state"));
    const connection = scheduleConnection();
    await harness.start({ schedule: connection.request });
    const scheduler = await workflowSchedules({
      directory: harness.stateDirectory,
      runtimeDirectory: harness.runtimeDirectory,
      declarations: [scheduledWorkflow],
      scheduleClock: () => 0,
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
