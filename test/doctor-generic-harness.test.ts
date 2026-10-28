import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor } from "./doctor-fixture.ts";

await test("CLV-215 doctor explains missing generic turns and keeps probe failures", () =>
  withDoctor(async (scene) => {
    const path = await scene.program(
      "mytool",
      'if(process.argv[2] !== "--version") process.exit(99); console.log("mytool 1.2.3");',
    );
    const file = privateSettingsPath(scene.environment, scene.repository);
    await mkdir(dirname(file), { recursive: true });
    const save = (turn: readonly string[] | undefined) =>
      writeFile(
        file,
        JSON.stringify({
          version: 1,
          harness: {
            name: "mytool",
            kind: "file",
            path,
            ...(turn === undefined ? {} : { turn }),
          },
        }),
      );
    await save(undefined);
    const missing = check(await scene.report(), "default-harness");
    assert.equal(missing["result"], "fail");
    assert.match(String(missing["fix"]), /cloving config set harness\.turn/);
    await save([path, "{prompt}"]);
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "ok",
    );
    await scene.program("mytool", "process.exit(3)");
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "fail",
    );
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        harness: { name: "mytool", turn: ["missing-program"] },
      }),
    );
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "fail",
    );
  }));

await test("CLV-215 doctor probes a generic program whose filename differs from the harness name", () =>
  withDoctor(async (scene) => {
    const path = await scene.program(
      "wrapper",
      'if(process.argv[2] !== "--version") process.exit(99); console.log("mytool 1.2.3");',
    );
    const file = privateSettingsPath(scene.environment, scene.repository);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        harness: { name: "mytool", turn: [path, "--print", "{prompt}"] },
      }),
    );
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "ok",
    );
  }));
