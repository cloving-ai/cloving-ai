import { check, settings, withDoctor } from "./doctor-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";
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

await test("CLV-359 doctor accepts workflow working lanes below the general lane count", () =>
  withDoctor(async (scene) => {
    await writeQueueWorkflow(join(scene.repository, ".cloving/workflows"));
    const output = await scene.report({
      CLOVING_QUEUE_SECONDS: undefined,
      CLOVING_QUEUE_LANES: "6",
      CLOVING_QUEUES: '{"queued":{"workingLanes":5}}',
    });
    const interval = check(output, "queue-interval");
    assert.equal(interval["result"], "ok", String(interval["detail"]));
    assert.equal(interval["required"], true);
    assert.equal(interval["detail"], "120 seconds from the default");
    assert.equal(output.status, 0);
  }));

await test("CLV-359 doctor does not require the next command for a disabled queue", () =>
  withDoctor(async (scene) => {
    await writeQueueWorkflow(join(scene.repository, ".cloving/workflows"));
    await settings(scene, {
      version: 1,
      queues: { queued: { state: "off" } },
    });
    const environment = {
      CLOVING_QUEUE_SECONDS: undefined,
      CLOVING_NEXT_COMMAND: undefined,
    };
    const disabled = await scene.report(environment);
    assert.equal(check(disabled, "next-command")["required"], false);
    assert.equal(check(disabled, "ticket-command")["required"], true);
    assert.equal(check(disabled, "queue-interval")["result"], "ok");
    assert.match(
      String(check(disabled, "queue-interval")["detail"]),
      /queues setting turns off the queue of queued/,
    );
    assert.equal(disabled.status, 0);
    const enabled = await scene.report({
      ...environment,
      CLOVING_QUEUES: '{"queued":{"state":"on"}}',
    });
    assert.equal(check(enabled, "next-command")["required"], true);
    assert.equal(enabled.status, 1);
  }));

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
