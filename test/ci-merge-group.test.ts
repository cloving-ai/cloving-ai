import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { job, releaseWorkflow } from "./release-fixture.ts";
import type { ReleaseWorkflow } from "./release-schema-fixture.ts";

type JobName = keyof ReleaseWorkflow["jobs"];
type Context = Readonly<Record<string, string>>;

const mergeGroup: Context = { event_name: "merge_group", ref_type: "branch" };

function runsFor(condition: string | undefined, context: Context): boolean {
  if (condition === undefined) return true;
  const expression = /^\$\{\{ (.*) \}\}$/.exec(condition)?.[1];
  assert.ok(expression !== undefined, condition);
  return expression.split(" && ").every((term) => {
    if (term === "always()") return true;
    const comparison = /^github\.(\w+) (==|!=) '([^']*)'$/.exec(term);
    assert.ok(comparison !== null, term);
    const [, name = "", operator, value] = comparison;
    return (context[name] === value) === (operator === "==");
  });
}

function isJobName(workflow: ReleaseWorkflow, name: string): name is JobName {
  return Object.hasOwn(workflow.jobs, name);
}

function jobName(workflow: ReleaseWorkflow, name: string): JobName {
  assert.ok(isJobName(workflow, name), name);
  return name;
}

function behind(workflow: ReleaseWorkflow, name: JobName): readonly JobName[] {
  const needs = job(workflow, name).needs ?? [];
  return (typeof needs === "string" ? [needs] : needs)
    .map((need) => jobName(workflow, need))
    .flatMap((need) => [need, ...behind(workflow, need)]);
}

function summaryExit(script: string, event: string): number | null {
  return spawnSync("bash", ["-eo", "pipefail", "-c", script], {
    env: {
      PATH: process.env["PATH"],
      SHARD_RESULT: "success",
      COVERAGE_RESULT: "skipped",
      EVENT_NAME: event,
    },
  }).status;
}

await test("CLV-297 CI checks main and version tag pushes, every pull request, merge groups and manual runs", async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(workflow.on, {
    push: { branches: ["main"], tags: ["v*"] },
    pull_request: {},
    merge_group: {},
    workflow_dispatch: {},
  });
});

await test("CLV-297 the jobs behind quality and quality_linux run for a merge group and the coverage job does not", async () => {
  const workflow = await releaseWorkflow();
  for (const summary of ["quality", "quality_linux"] as const) {
    assert.equal(runsFor(job(workflow, summary).if, mergeGroup), true);
    const jobs = behind(workflow, summary);
    assert.ok(jobs.includes("coverage"), summary);
    assert.ok(jobs.length > 1, summary);
    for (const name of jobs)
      assert.equal(
        runsFor(job(workflow, name).if, mergeGroup),
        name !== "coverage",
        name,
      );
  }
});

await test("CLV-297 the summary steps accept a skipped coverage job for a merge group but not for a pull request", async () => {
  const workflow = await releaseWorkflow();
  for (const summary of ["quality", "quality_linux"] as const) {
    const script = job(workflow, summary).steps[0]?.run;
    assert.ok(script !== undefined, summary);
    for (const [event, status] of [
      ["merge_group", 0],
      ["pull_request", 1],
    ] as const) {
      assert.equal(summaryExit(script, event), status, `${summary} ${event}`);
    }
  }
});
