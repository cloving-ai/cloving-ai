import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctorWorkflow } from "./doctor-fixture.ts";
import { fields, items } from "./service-fixture.ts";
import {
  acceptedByVersion19,
  piBody,
  saveSelection,
  versionLines,
} from "./pi-factory-fixture.ts";

const lines = [...versionLines, "pi version 1.5.3: error"];

await test("#842 v1.9 doctor accepts a custom mypi harness whose program is pi 1.5.3", () =>
  withDoctorWorkflow(async (scene) => {
    await scene.program("pi", piBody("1.5.3"));
    await saveSelection(
      privateSettingsPath(scene.environment, scene.repository),
      { name: "mypi", turn: ["pi", "-p", "{prompt}"] },
    );
    const report = await scene.report();
    const selected = check(report, "default-harness");
    assert.equal(selected["required"], true);
    assert.match(String(selected["detail"]), /^harness mypi; probe ok;/);
    assert.equal(selected["result"], "ok");
    assert.equal(report.status, 0);
  }));

const customSelections = [
  {
    case: "turn",
    harness: () => ({ name: "mypi", turn: ["pi", "-p", "{prompt}"] }),
  },
  {
    case: "program path",
    harness: (program: string) => ({
      name: "mypi",
      turn: [program, "-p", "{prompt}"],
    }),
  },
  {
    case: "kind file with path",
    harness: (program: string) => ({
      name: "mypi",
      kind: "file",
      path: program,
      turn: ["mypi", "-p", "{prompt}"],
    }),
  },
  {
    case: "command",
    harness: (program: string) => ({
      name: "mypi",
      turn: ["mypi", "{prompt}"],
      command: [program, "-p", "{prompt}"],
    }),
  },
  {
    case: "CLOVING_WORKER=mypi",
    harness: () => ({ name: "mypi", turn: ["pi", "-p", "{prompt}"] }),
    environment: { CLOVING_WORKER: "mypi" },
  },
] as const;

for (const selection of customSelections) {
  await test(`#842 v1.9 doctor gives the 1.9.0 default-harness result for a custom mypi ${selection.case} that runs pi`, () =>
    withDoctorWorkflow(async (scene) => {
      const program = await scene.program("pi", piBody("1.5.3"));
      await saveSelection(
        privateSettingsPath(scene.environment, scene.repository),
        selection.harness(program),
      );
      for (const line of lines) {
        await scene.program("pi", piBody(line));
        const report = await scene.report(
          "environment" in selection ? selection.environment : {},
        );
        const accepted = acceptedByVersion19(line);
        const selected = check(report, "default-harness");
        assert.equal(selected["result"], accepted ? "ok" : "fail", line);
        assert.equal(report.status, accepted ? 0 : 1, line);
        assert.match(
          String(selected["detail"]),
          accepted ? /^harness mypi; probe ok;/ : /; probe no-version;/,
          line,
        );
      }
    }));
}

const nativeReasons: Readonly<Record<string, string>> = {
  "1.5.2": "ok",
  "1.5.3": "unsupported-version",
};

const nativeSelections = [
  { case: "CLOVING_WORKER=pi", environment: { CLOVING_WORKER: "pi" } },
  { case: "a saved pi with no turn", harness: { name: "pi", kind: "file" } },
] as const;

for (const selection of nativeSelections) {
  await test(`#842 doctor keeps the native Pi pin in default-harness for ${selection.case}`, () =>
    withDoctorWorkflow(async (scene) => {
      const program = await scene.program("pi", piBody("1.5.2"));
      if ("harness" in selection)
        await saveSelection(
          privateSettingsPath(scene.environment, scene.repository),
          { ...selection.harness, path: program },
        );
      for (const line of lines) {
        await scene.program("pi", piBody(line));
        const report = await scene.report(
          "environment" in selection ? selection.environment : {},
        );
        const reason = nativeReasons[line] ?? "no-version";
        const selected = check(report, "default-harness");
        assert.match(
          String(selected["detail"]),
          new RegExp(`^harness pi; probe ${reason};`),
          line,
        );
        assert.equal(report.status, reason === "ok" ? 0 : 1, line);
      }
    }));
}

const discoverySelections = [
  { case: "no saved harness", native: "no", settings: {} },
  {
    case: "a custom mypi turn",
    native: "no",
    settings: { harness: { name: "mypi", turn: ["pi", "-p", "{prompt}"] } },
  },
  {
    case: "a saved pi with a turn",
    native: "no",
    settings: { harness: { name: "pi", turn: ["pi", "-p", "{prompt}"] } },
  },
  {
    case: "CLOVING_WORKER=pi",
    native: "yes",
    settings: {},
    environment: { CLOVING_WORKER: "pi" },
  },
  {
    case: "a saved pi with no turn",
    native: "yes",
    settings: { harness: { name: "pi", kind: "file" } },
  },
  {
    case: "a profile with harness pi",
    native: "yes",
    settings: { profiles: { native: { harness: "pi" } } },
  },
] as const;

for (const selection of discoverySelections) {
  await test(`#842 doctor harnesses with only Pi installed and ${selection.case} ${selection.native === "yes" ? "keeps the native Pi pin" : "gives the 1.9.0 result"}`, () =>
    withDoctorWorkflow(async (scene) => {
      await rm(join(scene.root, "bin", "claude"));
      await rm(join(scene.root, "bin", "codex"));
      const file = privateSettingsPath(scene.environment, scene.repository);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({ version: 1, ...selection.settings }),
      );
      for (const line of lines) {
        await scene.program("pi", piBody(line));
        const report = await scene.report(
          "environment" in selection ? selection.environment : {},
        );
        const working =
          selection.native === "yes"
            ? line === "1.5.2"
            : acceptedByVersion19(line);
        const discovery = check(report, "harnesses");
        assert.equal(discovery["result"], working ? "ok" : "fail", line);
        const entries = items(
          fields(JSON.parse(String(discovery["detail"])))["entries"],
        ).map(fields);
        assert.deepEqual(
          entries.map((entry) => [
            entry["name"],
            entry["version"],
            entry["working"],
          ]),
          [["pi", working ? line : null, working]],
          line,
        );
      }
    }));
}

await test("#842 doctor harnesses read a CLOVING_PROFILES file to find a native Pi profile", () =>
  withDoctorWorkflow(async (scene) => {
    const file = privateSettingsPath(scene.environment, scene.repository);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, profiles: { native: { harness: "pi" } } }),
    );
    const profiles = join(scene.root, "profiles.json");
    await scene.program("pi", piBody("1.5.3"));
    const piEntry = async (environment: NodeJS.ProcessEnv) =>
      items(
        fields(
          JSON.parse(
            String(
              check(await scene.report(environment), "harnesses")["detail"],
            ),
          ),
        )["entries"],
      )
        .map(fields)
        .find((entry) => entry["name"] === "pi");
    await writeFile(
      profiles,
      JSON.stringify({ profiles: { other: { harness: "codex" } } }),
    );
    assert.equal(
      (await piEntry({ CLOVING_PROFILES: profiles }))?.["working"],
      true,
    );
    await writeFile(
      profiles,
      JSON.stringify({ profiles: { native: { harness: "pi" } } }),
    );
    await writeFile(file, JSON.stringify({ version: 1 }));
    assert.equal(
      (await piEntry({ CLOVING_PROFILES: profiles }))?.["reason"],
      "unsupported-version",
    );
  }));
