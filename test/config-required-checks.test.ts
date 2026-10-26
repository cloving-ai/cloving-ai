import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { checkRun, ciScenario } from "./github-ci-fixture.ts";
import { settingsScene } from "./project-settings-fixture.ts";

await test("CLV-205 startup snapshots retain required-check name validation", async () => {
  await assert.rejects(
    ciScenario({
      requiredChecks: [""],
      timing: { ciLimitMilliseconds: 20 },
      snapshots: [[]],
    }),
    { message: "invalid-payload" },
  );
});

await test("CLV-205 startup required checks do not reload changed files during a merge", async () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.project, {
      version: 1,
      checks: { required: ["changed"] },
    });
    for (const requiredChecks of [null, ["unit"]]) {
      const { result } = await ciScenario({
        folder: fixture.repository,
        requiredChecks,
        snapshots: [[checkRun({ name: "unit" })]],
      });
      assert.equal(result, undefined);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
