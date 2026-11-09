import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { scheduledWorkflow } from "./workflow-scheduler-fixture.ts";
import { fields, items, parsed, type Harness } from "./service-fixture.ts";
import { withSchedule } from "./cli-schedule-fixture.ts";

const developLoop = {
  declarations: [{ ...scheduledWorkflow, workflowId: "develop" }],
  clock: 0,
};

async function listedSchedule(
  harness: Harness,
): Promise<Readonly<Record<string, unknown>>> {
  const listed = await harness.cli(["schedule", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  return fields(items(parsed(listed)["schedules"])[0]);
}

await test("CLV-328 schedule run admits one manual run with the schedule input and the mark, and keeps the next slot", () =>
  withSchedule(async (harness) => {
    const before = await listedSchedule(harness);
    const admitted = await harness.cli([
      "schedule",
      "run",
      "develop",
      "--command-id",
      "first",
      "--json",
    ]);
    assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
    const result = parsed(admitted);
    const runId = runIdentity("loop:develop:first");
    assert.equal(result["kind"], "run-admitted");
    assert.equal(result["runId"], runId);
    assert.deepEqual(harness.resolved, [
      {
        workflowId: "develop",
        submission: { prompt: "current" },
        commandId: "loop:develop:first",
      },
    ]);
    const after = await listedSchedule(harness);
    assert.equal(after["nextAt"], before["nextAt"]);
    assert.equal(after["lastSlot"], before["lastSlot"]);
    assert.equal(after["activeRunId"], null);
    const status = await harness.cli(["status", runId, "--json"]);
    assert.equal(fields(parsed(status)["run"])["manualFromLoop"], true);
    const plain = await harness.cli(["status", runId]);
    assert.match(plain.stdout, /^manual from loop$/m);
    const listed = await harness.cli(["status"]);
    assert.match(listed.stdout, new RegExp(`${runId}.*manual from loop`));
  }, developLoop));

await test("CLV-328 schedule run refuses a second run while a run of the workflow is active and replays its own command", () =>
  withSchedule(async (harness) => {
    const first = await harness.cli(["schedule", "run", "develop"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^Run run-[0-9a-f]{32} is admitted\.$/m);
    const refused = await harness.cli([
      "schedule",
      "run",
      "develop",
      "--command-id",
      "second",
      "--json",
    ]);
    assert.equal(refused.status, 1);
    assert.equal(parsed(refused)["code"], "run-active");
    const plain = await harness.cli(["schedule", "run", "develop"]);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /run-active/);
    assert.equal(harness.resolved.length, 1);
  }, developLoop));

await test("CLV-328 schedule run replays the same command ID with the same run", () =>
  withSchedule(async (harness) => {
    const command = ["schedule", "run", "develop", "--command-id", "again"];
    const first = await harness.cli([...command, "--json"]);
    const second = await harness.cli([...command, "--json"]);
    assert.equal(second.status, 0, second.stdout);
    assert.equal(parsed(second)["runId"], parsed(first)["runId"]);
    assert.equal(parsed(second)["replayed"], true);
    assert.equal(harness.resolved.length, 1);
  }, developLoop));

await test("CLV-328 schedule run refuses an unknown schedule", () =>
  withSchedule(async (harness) => {
    const refused = await harness.cli(["schedule", "run", "missing", "--json"]);
    assert.equal(refused.status, 1);
    assert.equal(parsed(refused)["code"], "unknown-schedule");
    assert.equal(harness.resolved.length, 0);
  }, developLoop));

await test("CLV-328 schedule help shows the run action and its command ID option", () => {
  const usage = commandUsage["schedule"] ?? "";
  assert.match(
    usage,
    /^ +cloving schedule run <workflowId> \[--command-id <id>\] \[--json\]$/m,
  );
  assert.match(usage, /manual from loop/);
  assert.match(usage, /run-active/);
});

await test("CLV-328 schedule run arguments refuse a missing workflow, a bad command ID and an option of another action", () => {
  for (const args of [
    ["run"],
    ["run", "develop", "--command-id", "bad id"],
    ["run", "develop", "extra"],
    ["pause", "develop", "--command-id", "one"],
  ])
    assert.equal(
      parseInvocation(["schedule", ...args]).kind,
      "usage-error",
      JSON.stringify(args),
    );
});

await test("CLV-328 the README describes the Loops panel, its controls, cloving schedule run, the MCP tools and the schedules route", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /The \*\*Loops\*\* panel at the side of the floor/);
  assert.match(readme, /\*\*Run now\*\*.*`cloving schedule run <workflowId>`/);
  assert.match(readme, /`cloving schedule pause <workflowId>`.*switch/s);
  assert.match(
    readme,
    /`cloving schedule run <workflowId> \[--command-id <id>\] \[--json\]`/,
  );
  assert.match(
    readme,
    /`cloving_schedules`, `cloving_schedule_pause`, `cloving_schedule_resume` and `cloving_schedule_run`/,
  );
  assert.match(readme, /^- `GET \/api\/v1\/schedules` gives the loops/m);
  assert.match(
    readme,
    /the queue control, the loop controls and their endpoints/,
  );
  assert.match(readme, /`manual from loop`/);
});
