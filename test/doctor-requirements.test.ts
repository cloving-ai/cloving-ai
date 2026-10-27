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
  scope: "bundled",
  workflowId: "develop-issue",
  capabilities: ["github"],
};

await test("CLV-207 a user workflow with github makes both GitHub checks required", () => {
  const codes = requiredDoctorCodes(
    [{ scope: "user", workflowId: "custom", capabilities: ["github"] }],
    { queueSeconds: undefined },
  );
  assert.ok(codes.includes("gh-login"));
  assert.ok(codes.includes("github-origin"));
  assert.ok(!codes.includes("check-command"));
});

await test("CLV-207 bundled issue needs ticket and check commands and PRD needs private texts", () => {
  const codes = requiredDoctorCodes(
    [
      issue,
      { scope: "bundled", workflowId: "develop-prd", capabilities: ["github"] },
    ],
    { queueSeconds: undefined },
  );
  assert.ok(codes.includes("check-command"));
  assert.ok(codes.includes("ticket-command"));
  assert.ok(codes.includes("private-texts"));
});

await test("CLV-207 bundled ticket needs the ticket command without requiring a merge check", () => {
  const codes = requiredDoctorCodes(
    [
      {
        scope: "bundled",
        workflowId: "develop-ticket",
        capabilities: ["claude"],
      },
    ],
    { queueSeconds: undefined },
  );
  assert.ok(codes.includes("ticket-command"));
  assert.ok(!codes.includes("check-command"));
});

await test("CLV-207 queue settings require next command only with a bundled queue workflow", () => {
  const active = requiredDoctorCodes([issue], { queueSeconds: "30" });
  assert.ok(active.includes("next-command"));
  assert.ok(active.includes("queue-interval"));
  const inactive = requiredDoctorCodes([], { queueSeconds: "30" });
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
    const codes = requiredDoctorCodes(workflows, { queueSeconds: undefined });
    assert.ok(codes.includes("gh-login"));
    assert.ok(codes.includes("github-origin"));
  });
});
