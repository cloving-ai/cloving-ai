import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { developManifest } from "./develop-template-fixture.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";

const unset =
  "demo.tool is not set. The record option of the develop demo point needs it.";

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

await test("CLV-315 attach-asset alone does not make demo-tool required, and the record option needs it", () =>
  withDoctor(async (scene) => {
    for (const github of [["open-pr"], ["open-pr", "attach-asset"]]) {
      await demoWorkflow(scene, github);
      const shown = check(await scene.report(), "demo-tool");
      assert.deepEqual(
        [shown["result"], shown["required"], shown["detail"]],
        ["skip", false, unset],
      );
    }
    const point = (await developManifest()).points.find(
      (entry) => entry.id === "demo",
    );
    assert.deepEqual(
      point?.options.map((option) => [option.id, option.needs]),
      [
        ["none", []],
        ["record", ["demo-tool"]],
      ],
    );
  }));

await test("CLV-315 doctor reports a relative, missing or unreadable demo.tool", () =>
  withDoctor(async (scene) => {
    await demoWorkflow(scene, ["attach-asset"]);
    const unreadable = join(scene.root, "unreadable.md");
    await writeFile(unreadable, "Secret steps.");
    await chmod(unreadable, 0o000);
    const cases = [
      ["skills/demo", "demo.tool must be an absolute path"],
      [
        join(scene.root, "missing"),
        `demo.tool ${join(scene.root, "missing")} is missing or unreadable`,
      ],
      [unreadable, `demo.tool ${unreadable} is missing or unreadable`],
    ] as const;
    for (const [tool, detail] of cases) {
      const shown = check(
        await scene.report({ CLOVING_DEMO_TOOL: tool }),
        "demo-tool",
      );
      assert.deepEqual(
        [shown["result"], shown["required"], shown["detail"]],
        ["fail", false, detail],
      );
      assert.match(String(shown["fix"]), /cloving config set demo\.tool /);
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
