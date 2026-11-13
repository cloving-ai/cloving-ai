import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { configurationEntries } from "../src/configuration-display.ts";
import { resolveSettings, settingDigests } from "../src/project-settings.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor } from "./doctor-fixture.ts";

await test("CLV-373 legacy pi settings do not inherit native commands or hide their saved command", () => {
  for (const command of [undefined, ["custom", "{prompt}"]]) {
    const settings = JSON.stringify({
      version: 1,
      harness: {
        name: "pi",
        turn: ["custom"],
        ...(command === undefined ? {} : { command }),
      },
    });
    const environment = { CLOVING_PI_COMMAND: '["foreign","--mode","json"]' };
    const input = { project: undefined, private: settings };
    const [entry] = configurationEntries({
      ...input,
      environment,
      field: "harness.command",
    });
    assert.deepEqual(entry, {
      field: "harness.command",
      value: command ?? null,
      source: command === undefined ? "default" : "private",
      hidden: [],
    });
    const resolved = resolveSettings({}, input);
    assert.equal(resolved.environment["CLOVING_PI_COMMAND"], undefined);
    const changed = resolveSettings(environment, input);
    assert.equal(
      settingDigests(resolved, String)["harness.command"],
      settingDigests(changed, String)["harness.command"],
    );
  }
});

await test("CLV-373 native Pi command display ignores an unrelated saved text turn", () => {
  const command = ["native-pi", "--mode", "json"];
  for (const saved of [undefined, ["custom", "{prompt}"]]) {
    const [entry] = configurationEntries({
      project: undefined,
      private: JSON.stringify({
        version: 1,
        harness: {
          name: "mytool",
          turn: ["custom"],
          ...(saved === undefined ? {} : { command: saved }),
        },
      }),
      environment: {
        CLOVING_WORKER: "pi",
        CLOVING_PI_COMMAND: JSON.stringify(command),
      },
      field: "harness.command",
    });
    assert.deepEqual(entry, {
      field: "harness.command",
      value: command,
      source: "environment",
      hidden: saved === undefined ? [] : [{ source: "private", value: saved }],
    });
  }
});

for (const kind of ["file", "shell"] as const) {
  await test(`CLV-373 doctor probes custom pi ${kind} as a generic text harness`, () =>
    withDoctor(async (scene) => {
      const path = await scene.program(
        "pi",
        'if(process.argv[2] !== "--version") process.exit(99); console.log("custom pi 9.8.7");',
      );
      const file = privateSettingsPath(scene.environment, scene.repository);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          harness: { name: "pi", kind, path, turn: [path, "{prompt}"] },
        }),
      );
      const selected = check(
        await scene.report({ SHELL: "/bin/bash" }),
        "default-harness",
      );
      assert.equal(selected["result"], "ok", String(selected["detail"]));
    }));
}
