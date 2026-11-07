import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { doctorWorkflows } from "../src/cli/doctor-workflows.ts";
import { requiredDoctorCodes } from "../src/doctor-report.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

async function demoWorkflow(scene: DoctorScene, github: readonly string[]) {
  const folder = join(scene.repository, ".cloving/workflows");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "custom.ts"), 'throw new Error("must not run")');
  await writeFile(
    join(folder, "custom.declaration.json"),
    JSON.stringify({
      workflow: {
        workflowId: "custom",
        capabilities: ["claude", "github"],
        effectLimit: 3,
        input: { maximumBytes: 4096, fields: {} },
      },
      methods: { claude: ["run-turn"], github },
    }),
  );
}

await test("CLV-315 a workflow that declares attach-asset makes demo-tool required", () =>
  withDoctor(async (scene) => {
    await demoWorkflow(scene, ["open-pr", "attach-asset"]);
    const workflows = await doctorWorkflows(
      scene.repository,
      scene.environment,
    );
    assert.ok(requiredDoctorCodes(workflows).includes("demo-tool"));
    assert.ok(
      !requiredDoctorCodes([
        { scope: "user", workflowId: "other", capabilities: ["github"] },
      ]).includes("demo-tool"),
    );
  }));

await test("CLV-315 doctor reports a missing, relative or unreadable demo.tool for a demo workflow", () =>
  withDoctor(async (scene) => {
    await demoWorkflow(scene, ["attach-asset"]);
    const unreadable = join(scene.root, "unreadable.md");
    await writeFile(unreadable, "Secret steps.");
    await chmod(unreadable, 0o000);
    const cases = [
      [undefined, "demo.tool is not set, and a workflow declares attach-asset"],
      ["skills/demo", "demo.tool must be an absolute path"],
      [
        join(scene.root, "missing"),
        `demo.tool ${join(scene.root, "missing")} is missing or unreadable`,
      ],
      [unreadable, `demo.tool ${unreadable} is missing or unreadable`],
    ] as const;
    for (const [tool, detail] of cases) {
      const output = await scene.report(
        tool === undefined ? {} : { CLOVING_DEMO_TOOL: tool },
      );
      const shown = check(output, "demo-tool");
      assert.deepEqual(
        [shown["result"], shown["required"], shown["detail"]],
        ["fail", true, detail],
      );
      assert.match(String(shown["fix"]), /cloving config set demo\.tool /);
      assert.equal(output.status, 1);
    }
  }));

await test("CLV-315 doctor accepts a readable demo.tool file or folder", () =>
  withDoctor(async (scene) => {
    await demoWorkflow(scene, ["attach-asset"]);
    const folder = join(scene.root, "skills/demo");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), "Record the scene.");
    for (const tool of [folder, join(folder, "SKILL.md")]) {
      const shown = check(
        await scene.report({ CLOVING_DEMO_TOOL: tool }),
        "demo-tool",
      );
      assert.deepEqual(
        [shown["result"], shown["detail"]],
        ["ok", `demo.tool ${tool} is readable`],
      );
    }
  }));

await test("CLV-315 doctor skips demo-tool when no workflow declares attach-asset", () =>
  withDoctor(async (scene) => {
    await demoWorkflow(scene, ["open-pr"]);
    const shown = check(await scene.report(), "demo-tool");
    assert.deepEqual(
      [shown["result"], shown["required"], shown["detail"]],
      [
        "skip",
        false,
        "demo.tool is not set, and no workflow declares attach-asset",
      ],
    );
  }));
