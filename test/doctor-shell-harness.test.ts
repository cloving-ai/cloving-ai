import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { shellTurnScript } from "../src/agent-harness-shell.ts";
import { harnessObservations } from "../src/cli/doctor-harness.ts";
import { commitSignatureObservation } from "../src/cli/doctor-turns.ts";
import type { ProbeOptions, ProbeRunner } from "../src/cli/probe-command.ts";
import {
  check,
  savedHarness,
  withDoctor,
  type DoctorScene,
} from "./doctor-fixture.ts";
import {
  agentSigner,
  repositoryState,
  signing,
} from "./doctor-signature-fixture.ts";
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

async function shellSigning(
  scene: DoctorScene,
  startup: { readonly exportsAgent: boolean },
): Promise<void> {
  await signing(scene, { format: "ssh", body: agentSigner });
  await savedHarness(scene, { kind: "shell", path: "claude_alias" });
  const agentLine = `export SSH_AUTH_SOCK='${join(scene.root, "agent.sock")}'`;
  await writeFile(
    join(scene.root, ".bash_profile"),
    [
      'echo "welcome from the login shell"',
      'echo "a startup note" >&2',
      `alias claude_alias='${join(scene.root, "bin", "claude")}'`,
      ...(startup.exportsAgent ? [agentLine] : []),
    ].join("\n"),
  );
}

await test("CLV-344 with a saved shell harness, commit-signatures gives ok when the login shell of a turn exports the SSH agent", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: true });
    const before = repositoryState(scene);
    const shown = check(
      await scene.report({ SHELL: "/bin/bash" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "ok");
    assert.equal(shown["detail"], "A turn can sign commits (gpg.format ssh)");
    assert.equal(repositoryState(scene), before);
  }));

await test("CLV-344 with a saved shell harness whose login shell does not export the SSH agent, commit-signatures fails with the error line of git, not the startup output", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: false });
    const shown = check(
      await scene.report({ SHELL: "/bin/bash" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "A turn cannot sign commits (gpg.format ssh): error: signer: no SSH agent",
    );
  }));

async function signatureCalls(
  kind: "shell" | "file",
): Promise<readonly string[][]> {
  const calls: string[][] = [];
  await commitSignatureObservation({
    repository: "/repository",
    environment: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
    probe: (executable, options) => {
      calls.push([executable, ...options.arguments]);
      return Promise.resolve({
        stdout: "",
        reason: "probe-failed",
        exitCode: 1,
      });
    },
    runners: {
      profiles: { other: { harness: "codex", env: { NAME: "value" } } },
      boxed: [],
      problems: [],
    },
    harness: { name: "claude", kind, path: "claude_alias" },
  });
  return calls;
}

const configRead = ["git", "config", "--type=bool", "--get", "commit.gpgsign"];

await test("CLV-344 the test signature runs git through the login shell of a turn for a saved shell harness, and runs git directly for a file harness or a profile with another harness", async () => {
  const [shell = [], shellProfile] = await signatureCalls("shell");
  assert.deepEqual(shell.slice(0, 6), [
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    shellTurnScript,
    "cloving-harness",
  ]);
  assert.deepEqual(shell.slice(7), configRead);
  assert.equal(existsSync(String(shell[6])), false);
  assert.deepEqual(shellProfile, configRead);
  assert.deepEqual(await signatureCalls("file"), [configRead, configRead]);
});
