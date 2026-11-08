import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyNumbers } from "../src/report-days.ts";
import { workspaceModel } from "../src/cli/watch-workspace.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";

function today(numbers: {
  readonly completed: number;
  readonly stopped: number;
  readonly costUsd: number;
  readonly unknownCostRuns: number;
  readonly knownCostCompleted: number;
  readonly costPerCompletedRunUsd: number | null;
  readonly days: readonly number[];
}): DailyNumbers {
  return {
    completed: numbers.completed,
    stopped: numbers.stopped,
    costUsd: numbers.costUsd,
    unknownCostRuns: numbers.unknownCostRuns,
    knownCostCompleted: numbers.knownCostCompleted,
    costPerCompletedRunUsd: numbers.costPerCompletedRunUsd,
    yesterday: { completed: 1, costUsd: 0.5, unknownCostRuns: 0 },
    days: numbers.days.map((completed, index) => ({
      date: `2026-11-0${String(index + 1)}`,
      completed,
    })),
    workflows: [
      {
        workflowId: "develop-issue",
        completed: numbers.completed,
        costUsd: numbers.costUsd,
        unknownCostRuns: numbers.unknownCostRuns,
      },
    ],
  };
}

await test("CLV-312 the workspace model lists each repository and names the repository of each workflow and run", () => {
  const alpha = floorModel([
    floorRun("alpha-run", { operation: "claude-turn", minutes: 4 }),
  ]);
  const beta = floorModel(
    [floorRun("beta-run", { operation: "github-open-pr", minutes: 9 })],
    { service: "down" },
  );
  const model = workspaceModel([
    { name: "alpha", model: alpha },
    { name: "beta", model: beta },
  ]);
  assert.deepEqual(
    model.repositories?.map((repository) => [
      repository.name,
      repository.service,
    ]),
    [
      ["alpha", "up"],
      ["beta", "down"],
    ],
  );
  assert.deepEqual(
    model.workflows.map((workflow) => [
      workflow.repository,
      workflow.workflowId,
    ]),
    [
      ["alpha", "develop-issue"],
      ["alpha", "idea"],
      ["beta", "develop-issue"],
      ["beta", "idea"],
    ],
  );
  assert.deepEqual(
    model.runs.map((run) => [run.repository, run.runId]),
    [
      ["alpha", "alpha-run"],
      ["beta", "beta-run"],
    ],
  );
  assert.equal(model.service, "down");
  assert.deepEqual(model.cardForms, []);
  assert.equal(model.updatedAt, alpha.updatedAt);
});

await test("CLV-312 the workspace service is up only when the service of each repository is up", () => {
  const model = workspaceModel([
    { name: "alpha", model: floorModel([]) },
    { name: "beta", model: floorModel([]) },
  ]);
  assert.equal(model.service, "up");
});

await test("CLV-312 the workspace Today numbers add the numbers of each repository and keep one row for each repository", () => {
  const alphaToday = today({
    completed: 2,
    stopped: 1,
    costUsd: 3,
    unknownCostRuns: 0,
    knownCostCompleted: 2,
    costPerCompletedRunUsd: 1.5,
    days: [1, 2],
  });
  const betaToday = today({
    completed: 1,
    stopped: 0,
    costUsd: 1,
    unknownCostRuns: 1,
    knownCostCompleted: 1,
    costPerCompletedRunUsd: 1,
    days: [0, 1],
  });
  const model = workspaceModel([
    { name: "alpha", model: floorModel([], { today: alphaToday }) },
    { name: "beta", model: floorModel([], { today: betaToday }) },
  ]);
  assert.deepEqual(model.today, {
    completed: 3,
    stopped: 1,
    costUsd: 4,
    unknownCostRuns: 1,
    knownCostCompleted: 3,
    costPerCompletedRunUsd: 4 / 3,
    yesterday: { completed: 2, costUsd: 1, unknownCostRuns: 0 },
    days: [
      { date: "2026-11-01", completed: 1 },
      { date: "2026-11-02", completed: 3 },
    ],
    workflows: [],
  });
  assert.deepEqual(
    model.repositories?.map((repository) => [
      repository.name,
      repository.today,
    ]),
    [
      ["alpha", alphaToday],
      ["beta", betaToday],
    ],
  );
});

await test("CLV-312 the workspace Today numbers give no cost per completed run when no repository knows one", () => {
  const numbers = today({
    completed: 0,
    stopped: 2,
    costUsd: 0,
    unknownCostRuns: 2,
    knownCostCompleted: 0,
    costPerCompletedRunUsd: null,
    days: [0],
  });
  const model = workspaceModel([
    { name: "alpha", model: floorModel([], { today: numbers }) },
    { name: "beta", model: floorModel([]) },
  ]);
  assert.deepEqual(
    [model.today?.costPerCompletedRunUsd, model.today?.stopped],
    [null, 2],
  );
  assert.deepEqual(
    model.repositories?.map((repository) => repository.today),
    [numbers, undefined],
  );
});

await test("CLV-312 the workspace cost per completed run counts only the completed runs with a known cost, also in a repository whose known runs cost nothing", () => {
  const free = today({
    completed: 2,
    stopped: 0,
    costUsd: 0,
    unknownCostRuns: 1,
    knownCostCompleted: 1,
    costPerCompletedRunUsd: 0,
    days: [2],
  });
  const paid = today({
    completed: 1,
    stopped: 0,
    costUsd: 3,
    unknownCostRuns: 0,
    knownCostCompleted: 1,
    costPerCompletedRunUsd: 3,
    days: [1],
  });
  const model = workspaceModel([
    { name: "alpha", model: floorModel([], { today: free }) },
    { name: "beta", model: floorModel([], { today: paid }) },
  ]);
  assert.equal(model.today?.costPerCompletedRunUsd, 1.5);
  assert.equal(model.today.knownCostCompleted, 2);
});
