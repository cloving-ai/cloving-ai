import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { initPromptFacts } from "../src/cli/init-prompt-command.ts";
import { nativePiSelected } from "../src/harness-defaults.ts";
import { withDoctor, type DoctorScene } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import {
  acceptedByVersion19,
  piBody,
  probe,
  saveSelection,
  savedHarness,
  setupPi,
  versionLines,
} from "./pi-factory-fixture.ts";

const lines = [...versionLines, "pi version 1.5.3: error"];
const noWorker = "no worker; ask for harness.turn";
const localRefusals: Readonly<Record<string, RegExp>> = {
  "1.5.2": /^$/,
  "1.5.3": /harness-unusable: unsupported-version/,
};

const selections = [
  {
    case: "no saved harness",
    native: "no",
    worker: () => "native claude",
  },
  {
    case: "a custom mypi turn",
    native: "no",
    harness: { name: "mypi", turn: ["pi", "-p", "{prompt}"] },
    worker: () => "one-shot mypi",
  },
  {
    case: "CLOVING_WORKER=pi",
    native: "yes",
    environment: { CLOVING_WORKER: "pi" },
    worker: (line: string) => (line === "1.5.2" ? "native pi" : noWorker),
  },
  {
    case: "a profile with harness pi",
    native: "yes",
    profiles: { native: { harness: "pi" } },
    worker: () => "native claude",
  },
] as const;

async function piFacts(
  scene: DoctorScene,
  environment: NodeJS.ProcessEnv,
): Promise<readonly unknown[]> {
  const facts = await initPromptFacts({
    repository: scene.repository,
    environment,
    probe,
  });
  return [facts.harnesses.filter((entry) => entry.name === "pi"), facts.worker];
}

for (const selection of selections) {
  await test(`#842 setup facts for ${selection.case} ${selection.native === "yes" ? "keep the native Pi pin" : "give the 1.9.0 Pi discovery"}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
      const environment = {
        ...pi.environment,
        ...("environment" in selection ? selection.environment : {}),
      };
      if ("harness" in selection)
        await saveSelection(pi.file, selection.harness);
      if ("profiles" in selection) {
        await mkdir(dirname(pi.file), { recursive: true });
        await writeFile(
          pi.file,
          JSON.stringify({ version: 1, profiles: selection.profiles }),
        );
      }
      for (const line of lines) {
        await scene.program("pi", piBody(line));
        const working =
          selection.native === "yes"
            ? line === "1.5.2"
            : acceptedByVersion19(line);
        assert.deepEqual(
          await piFacts(scene, environment),
          [
            [{ name: "pi", version: working ? line : null, working }],
            selection.worker(line),
          ],
          line,
        );
      }
    }));
}

await test("#842 setup facts after factory setup keep the native Pi pin and give the 1.9.0 worker fact", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    for (const line of lines) {
      await scene.program("pi", piBody(line));
      const result = initCli(scene, {
        arguments: ["--harness", "pi"],
        environment: pi.environment,
      });
      assert.equal(result.status, acceptedByVersion19(line) ? 7 : 2, line);
      assert.deepEqual(await savedHarness(pi.file), pi.harness);
      const native = line === "1.5.2";
      assert.deepEqual(
        await piFacts(scene, pi.environment),
        [
          [{ name: "pi", version: native ? line : null, working: native }],
          native ? "native pi" : noWorker,
        ],
        line,
      );
    }
  }));

await test("#842 init --local keeps the native Pi pin for each Pi version line", () =>
  withDoctor(async (scene) => {
    const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
    for (const line of lines) {
      await scene.program("pi", piBody(line));
      const result = initCli(scene, {
        arguments: ["--local", "--harness", "pi"],
        environment: pi.environment,
      });
      assert.equal(result.status, line === "1.5.2" ? 0 : 2, line);
      assert.match(
        result.stderr,
        localRefusals[line] ?? /harness-unusable: no-version/,
        line,
      );
    }
    assert.deepEqual(await savedHarness(pi.file), pi.harness);
  }));

await test("#842 native Pi is selected by the worker, the saved name or a profile when no saved pi turn exists", () => {
  const text = { name: "pi", turn: ["pi", "{prompt}"] };
  const cases = [
    [{}, {}, false],
    [{ worker: "pi" }, {}, true],
    [{ harness: { name: "pi" } }, {}, true],
    [{ harness: { name: "mypi", turn: ["pi"] } }, {}, false],
    [{}, { native: { harness: "pi" } }, true],
    [{}, { other: { harness: "codex" }, plain: {} }, false],
    [{ worker: "pi", harness: text }, {}, false],
    [{ harness: text }, { native: { harness: "pi" } }, false],
    [{ worker: "pi", harness: { name: "mypi", turn: ["pi"] } }, {}, true],
  ] as const;
  for (const [settings, profiles, expected] of cases)
    assert.equal(
      nativePiSelected(settings, profiles),
      expected,
      JSON.stringify([settings, profiles]),
    );
});
