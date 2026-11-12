import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";

await test("CLV-364 init and doctor select qualified Pi and refuse a broken shim", () =>
  withDoctor(async (scene) => {
    const program = await scene.program("pi", 'console.log("1.5.2")');
    const initialized = initCli(scene, { arguments: ["--harness", program] });
    assert.equal(initialized.status, 0, initialized.stderr);
    const file = privateSettingsPath(scene.environment, scene.repository);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      version: 1,
      harness: { name: "pi", kind: "file", path: program },
    });
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "ok",
    );
    await scene.program(
      "pi",
      'console.log("Configured agent is unavailable. Install it or check the command configuration.")',
    );
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "fail",
    );
    assert.notEqual(
      initCli(scene, { arguments: ["--harness", program] }).status,
      0,
    );
  }));

await test("CLV-364 doctor uses the Pi command override for the selected worker", () =>
  withDoctor(async (scene) => {
    const program = await scene.program("pi", 'console.log("1.5.2")');
    const file = privateSettingsPath(scene.environment, scene.repository);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, harness: { name: "pi", path: "missing" } }),
    );
    assert.equal(
      check(
        await scene.report({
          CLOVING_WORKER: "pi",
          CLOVING_PI_COMMAND: JSON.stringify([program, "--mode", "json"]),
        }),
        "default-harness",
      )["result"],
      "ok",
    );
  }));

await test("CLV-364 doctor applies the Pi version contract to renamed command programs", () =>
  withDoctor(async (scene) => {
    const program = await scene.program("pi-wrapper", 'console.log("1.5.2")');
    assert.equal(
      check(
        await scene.report({
          CLOVING_WORKER: "pi",
          CLOVING_PI_COMMAND: JSON.stringify([program, "--mode", "json"]),
        }),
        "default-harness",
      )["result"],
      "ok",
    );
    await scene.program("pi-wrapper", 'console.log("1.5.1")');
    assert.equal(
      check(
        await scene.report({
          CLOVING_WORKER: "pi",
          CLOVING_PI_COMMAND: JSON.stringify([program]),
        }),
        "default-harness",
      )["result"],
      "fail",
    );
  }));
