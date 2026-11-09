import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, sameAsCli } from "./mcp-fixture.ts";
import { fields, parsed } from "./service-fixture.ts";
import { scheduledWorkflow } from "./workflow-scheduler-fixture.ts";
import { withSchedule } from "./cli-schedule-fixture.ts";

const developLoop = {
  declarations: [{ ...scheduledWorkflow, workflowId: "develop" }],
  clock: 0,
};

await test("CLV-328 cloving_schedules gives the JSON of cloving schedule", () =>
  withSchedule(async (harness) => {
    const listed = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_schedules",
    });
    const cli = await harness.cli(["schedule", "--json"]);
    assert.deepEqual(listed["structuredContent"], parsed(cli));
    assert.equal(fields(listed["structuredContent"])["kind"], "schedules");
  }, developLoop));

await test("CLV-328 cloving_schedule_pause and cloving_schedule_resume give the JSON of the commands", () =>
  withSchedule(async (harness) => {
    for (const [action, state] of [
      ["pause", "paused"],
      ["resume", "active"],
    ] as const) {
      const shown = await sameAsCli(harness, {
        name: `cloving_schedule_${action}`,
        arguments: { workflowId: "develop" },
        cli: ["schedule", action, "develop"],
      });
      assert.equal(fields(shown.cli["schedule"])["state"], state);
    }
    const missing = await sameAsCli(harness, {
      name: "cloving_schedule_pause",
      arguments: { workflowId: "missing" },
      cli: ["schedule", "pause", "missing"],
    });
    assert.equal(missing.cli["code"], "unknown-schedule");
  }, developLoop));

await test("CLV-328 cloving_schedule_run admits the loop run of the command, replays it, and refuses a second run with run-active", () =>
  withSchedule(async (harness) => {
    const shown = await sameAsCli(harness, {
      name: "cloving_schedule_run",
      arguments: { workflowId: "develop", commandId: "mcp-one" },
      cli: ["schedule", "run", "develop", "--command-id", "mcp-one"],
    });
    assert.equal(fields(shown.first["structuredContent"])["replayed"], false);
    assert.equal(shown.cli["replayed"], true);
    const refused = await sameAsCli(harness, {
      name: "cloving_schedule_run",
      arguments: { workflowId: "develop", commandId: "mcp-two" },
      cli: ["schedule", "run", "develop", "--command-id", "mcp-two"],
    });
    assert.equal(refused.first["isError"], true);
    assert.equal(refused.cli["code"], "run-active");
    assert.equal(harness.resolved.length, 1);
  }, developLoop));
