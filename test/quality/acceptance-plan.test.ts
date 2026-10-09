import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleAcceptancePlan } from "../../quality/acceptance-plan.ts";

const requirements = {
  staticChecks: ["inventory", "lint"],
  diagnosticChecks: ["diagnostics"],
  minimumTests: 3,
  scenarios: ["fake-report", "added-source"],
  artifacts: ["package", "workflow-handlers"],
  confinement: ["/usr/bin/env", "TMPDIR=/tmp"],
};

await test("QG-10 acceptance plan identity changes with any required check", () => {
  const plan = assembleAcceptancePlan(requirements);
  assert.equal(plan.identity, assembleAcceptancePlan(requirements).identity);
  for (const changed of [
    { ...requirements, staticChecks: ["inventory"] },
    { ...requirements, diagnosticChecks: ["diagnostics", "concurrency"] },
    { ...requirements, minimumTests: 2 },
    { ...requirements, scenarios: ["fake-report"] },
    { ...requirements, artifacts: ["package"] },
    { ...requirements, confinement: [] },
  ])
    assert.notEqual(assembleAcceptancePlan(changed).identity, plan.identity);
});

await test("QG-10 acceptance plan rejects empty, blank or duplicate requirements", () => {
  for (const key of [
    "staticChecks",
    "diagnosticChecks",
    "scenarios",
    "artifacts",
  ] as const) {
    for (const value of [[], [" "], ["same", "same"]])
      assert.throws(
        () => assembleAcceptancePlan({ ...requirements, [key]: value }),
        /invalid-acceptance-plan/,
      );
  }
  assert.throws(
    () => assembleAcceptancePlan({ ...requirements, confinement: [" "] }),
    /invalid-acceptance-plan/,
  );
  for (const minimumTests of [0, -1, 1.5, Number.NaN])
    assert.throws(
      () => assembleAcceptancePlan({ ...requirements, minimumTests }),
      /invalid-acceptance-plan/,
    );
});
