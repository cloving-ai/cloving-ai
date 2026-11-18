import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { probeHarness } from "../src/agent-harnesses.ts";
import { chooseHarness, selectedHarness } from "../src/cli/init-selection.ts";
import { check, withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import {
  acceptedByVersion19,
  asked,
  piBody,
  probe,
  savedHarness,
  setupMessage,
  setupPi,
} from "./pi-factory-fixture.ts";

const legacyLines = ["pi version 1.5.3", "v1.5.3", "1.5", "1.5.3"] as const;
const versionLines = [
  ...legacyLines,
  "1.5.2",
  "custom pi 9.8.7",
  "pi version 1.5.3: error",
  "Error: Pi 1.5.3 is unavailable",
  "pi 1.5.3 not found",
  "ERROR 1.5",
  "pi 1.5.3 Unavailable",
  "errors=0 1.5.3",
  "terror 1.5",
  "pi version unknown",
  "pi\n1.5.3",
];
const factoryRuns = [
  { case: "fresh", flags: [] },
  { case: "saved", flags: [] },
  { case: "explicit flag", flags: ["--factory"] },
] as const;

for (const line of legacyLines) {
  await test(`#833 v1.9 fresh, saved, picker and explicit factory setup accept the Pi line ${line}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind: "file", version: line });
      for (const run of factoryRuns) {
        const result = initCli(scene, {
          arguments: [...run.flags, "--harness", pi.target],
          environment: pi.environment,
        });
        assert.equal(result.status, 7, `${run.case}: ${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), setupMessage);
        assert.deepEqual(await savedHarness(pi.file), pi.harness);
      }
      const answers = asked();
      const selected = await chooseHarness({
        environment: pi.environment,
        current: pi.harness,
        probe,
        purpose: "factory-setup",
        question: answers.question,
      });
      assert.equal(selected.version, line);
      assert.match(answers.prompts[0] ?? "", /^ {2}1\. pi /);
    }));
}

await test("#833 the factory-setup decision matches the 1.9.0 rule for each Pi version line", () =>
  withDoctor(async (scene) => {
    for (const line of versionLines) {
      const program = await scene.program("pi", piBody(line));
      const decision = await selectedHarness(program, {
        environment: scene.environment,
        probe,
        purpose: "factory-setup",
      }).then(
        (entry) => entry.version,
        (error: unknown) => String(error),
      );
      assert.equal(
        decision,
        acceptedByVersion19(line)
          ? line
          : "Error: harness-unusable: no-version",
        line,
      );
      const native = await probeHarness(program, { env: scene.environment });
      assert.equal(native.entries[0]?.working, line === "1.5.2", line);
    }
  }));

await test("#833 init --local and native Pi doctor still refuse Pi lines that only factory setup accepts", () =>
  withDoctor(async (scene) => {
    for (const line of legacyLines.filter((value) => value !== "1.5.3")) {
      const pi = await setupPi(scene, { kind: "file", version: line });
      const result = initCli(scene, {
        arguments: ["--local", "--harness", pi.target],
        environment: pi.environment,
      });
      assert.equal(result.status, 2, line);
      assert.match(result.stderr, /harness-unusable: no-version/);
      const report = await scene.report({
        ...pi.environment,
        CLOVING_WORKER: "pi",
      });
      assert.match(
        String(check(report, "harnesses")["detail"]),
        /"name":"pi"[^}]*"working":false,"reason":"no-version"/,
      );
    }
  }));

const refusals = [
  {
    case: "a version line with an error word",
    body: piBody("pi version 1.5.3: error"),
    reason: "no-version",
  },
  {
    case: "a failed version probe",
    body: 'console.log("pi version 1.5.3"); process.exit(3);',
    reason: "probe-exit",
  },
] as const;

for (const refusal of refusals) {
  await test(`#833 factory setup keeps refusing a Pi with ${refusal.case}`, () =>
    withDoctor(async (scene) => {
      const pi = await setupPi(scene, { kind: "file", version: "1.5.3" });
      await scene.program("pi", refusal.body);
      const result = initCli(scene, {
        arguments: ["--factory", "--harness", pi.program],
        environment: pi.environment,
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        new RegExp(`harness-unusable: ${refusal.reason}`),
      );
      await assert.rejects(readFile(pi.file, "utf8"), { code: "ENOENT" });
    }));
}
