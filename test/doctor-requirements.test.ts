import { withDoctor } from "./doctor-fixture.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { doctorWorkflows } from "../src/cli/doctor-workflows.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requiredDoctorCodes,
  type DoctorWorkflow,
} from "../src/doctor-report.ts";

const issue: DoctorWorkflow = {
  scope: "project",
  workflowId: "develop-issue",
  capabilities: ["github"],
};

for (const queue of [false, true]) {
  await test(`CLV-218 doctor discovers declared ticket and queue requirements with queue ${String(queue)}`, async () => {
    await withDoctor(async (scene) => {
      const folder = join(scene.repository, ".cloving/workflows");
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, "custom.ts"),
        'throw new Error("must not run")',
      );
      await writeFile(
        join(folder, "custom.declaration.json"),
        JSON.stringify({
          workflow: {
            queue,
            workflowId: "custom",
            capabilities: ["claude"],
            effectLimit: 1,
            input: {
              maximumBytes: 4096,
              fields: { ticket: { type: "ticket" } },
            },
          },
          methods: { claude: ["turn"] },
        }),
      );
      const workflows = (
        await doctorWorkflows(scene.repository, scene.environment)
      ).filter((workflow) => workflow.scope === "project");
      assert.equal(workflows.length, 1);
      const codes = requiredDoctorCodes(workflows);
      assert.ok(codes.includes("ticket-command"));
      assert.equal(codes.includes("next-command"), queue);
      assert.equal(codes.includes("queue-interval"), queue);
    });
  });
}

await test("CLV-207 a user workflow with github makes both GitHub checks required", () => {
  const codes = requiredDoctorCodes([
    { scope: "user", workflowId: "custom", capabilities: ["github"] },
  ]);
  assert.ok(codes.includes("gh-login"));
  assert.ok(codes.includes("github-origin"));
  assert.ok(!codes.includes("check-command"));
});

await test("CLV-262 workflow IDs do not opt into the queue or ticket requirements", () => {
  const active = requiredDoctorCodes([issue]);
  assert.ok(!active.includes("ticket-command"));
  assert.ok(!active.includes("check-command"));
  assert.ok(!active.includes("private-texts"));
  assert.ok(!active.includes("next-command"));
  assert.ok(!active.includes("queue-interval"));
  const inactive = requiredDoctorCodes([]);
  assert.ok(!inactive.includes("next-command"));
  assert.ok(!inactive.includes("queue-interval"));
});

await test("CLV-207 user folder declarations contribute requirements without executing workflow code", async () => {
  await withDoctor(async (scene) => {
    const folder = join(scene.root, "config/cloving/workflows");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "custom.ts"),
      'throw new Error("workflow code must not run")',
    );
    await writeFile(
      join(folder, "custom.declaration.json"),
      JSON.stringify({
        workflow: {
          workflowId: "custom",
          capabilities: ["github"],
          effectLimit: 1,
          input: { maximumBytes: 1024, fields: {} },
        },
        methods: { github: ["read"] },
      }),
    );
    const workflows = (
      await doctorWorkflows(scene.repository, scene.environment)
    ).filter((workflow) => workflow.scope === "user");
    assert.equal(workflows.length, 1);
    const codes = requiredDoctorCodes(workflows);
    assert.ok(codes.includes("gh-login"));
    assert.ok(codes.includes("github-origin"));
  });
});
