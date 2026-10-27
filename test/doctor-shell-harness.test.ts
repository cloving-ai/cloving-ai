import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harnessObservations } from "../src/cli/doctor-harness.ts";
import type { ProbeOptions, ProbeRunner } from "../src/cli/probe-command.ts";
import { check, savedHarness, withDoctor } from "./doctor-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

function recordingProbe(calls: ProbeOptions[]): ProbeRunner {
  return (_executable, options) => {
    calls.push(options);
    return Promise.resolve({ stdout: "", reason: "probe-failed" });
  };
}

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  await test(`CLV-207 default-harness probes saved ${shell} aliases and functions as worker turns run them`, () =>
    withDoctor(async (scene) => {
      const claude = join(scene.root, "bin", "claude");
      const startup = `
alias claude_alias='${claude}'
claude_function() { '${claude}' "$@"; }
alias claude_broken='${join(scene.root, "missing", "claude")}'
`;
      await writeFile(join(scene.root, ".bash_profile"), startup);
      await writeFile(join(scene.root, ".zshrc"), startup);
      for (const [path, result] of [
        ["claude_alias", "ok"],
        ["claude_function", "ok"],
        ["claude_broken", "fail"],
      ] as const) {
        await savedHarness(scene, { kind: "shell", path });
        const selected = check(
          await scene.report({ SHELL: shell }),
          "default-harness",
        );
        assert.equal(
          selected["result"],
          result,
          `${path}: ${String(selected["detail"])}`,
        );
      }
    }));
}

await test("CLV-207 default-harness probes a saved shell harness from the repository folder", () =>
  withFiles({ "README.md": "A project.\n" }, async (directory) => {
    const calls: ProbeOptions[] = [];
    await harnessObservations(
      { SHELL: "/bin/zsh", PATH: "/usr/bin" },
      {
        directory,
        settingsValid: true,
        probe: recordingProbe(calls),
        commandEnvironment: { PATH: "/usr/bin" },
        harness: { name: "claude", kind: "shell", path: "claude_alias" },
      },
    );
    const probe = calls.find((call) => call.arguments.includes("claude_alias"));
    assert.equal(probe?.directory, directory);
  }));
