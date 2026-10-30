import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";

for (const changed of ["name", "kind", "path", "none"]) {
  await test(`CLV-209 init persists selection and clears stale commands on ${changed} change`, () =>
    withDoctor(async (scene) => {
      const file = await scene.program("grok", 'console.log("1.0.0")');
      const selected = { name: "grok", kind: "file", path: file };
      const commands = {
        command: ["old"],
        turn: ["old", "{prompt}"],
        output: "text",
      };
      const previous = {
        version: 1,
        queue: { everySeconds: 17 },
        privateTexts: ["private"],
        harness: {
          ...selected,
          ...commands,
          ...(changed === "none"
            ? {}
            : { [changed]: changed === "kind" ? "shell" : "old" }),
        },
      };
      const path = privateSettingsPath(scene.environment, scene.repository);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(previous), { mode: 0o644 });
      const result = initCli(scene, { arguments: ["--harness", file] });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        ...previous,
        harness: { ...selected, ...(changed === "none" ? commands : {}) },
      });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(path + ".bak")).mode & 0o777, 0o600);
      assert.deepEqual(
        JSON.parse(await readFile(path + ".bak", "utf8")),
        previous,
      );
    }));
}

await test("CLV-209 init creates a private settings file and leaves project settings unchanged", () =>
  withDoctor(async (scene) => {
    const file = await scene.program("grok", 'console.log("1.0.0")');
    const project = scene.repository + "/.cloving/config.json";
    await mkdir(dirname(project));
    const text = '{"version":1,"checks":{"beforeMerge":["npm","test"]}}';
    await writeFile(project, text);
    assert.equal(initCli(scene, { arguments: ["--harness", file] }).status, 0);
    const path = privateSettingsPath(scene.environment, scene.repository);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      harness: { name: "grok", kind: "file", path: file },
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(project, "utf8"), text);
  }));
