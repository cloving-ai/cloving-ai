import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  shellTurnPrelude,
  shellTurnScript,
} from "../src/agent-harness-shell.ts";
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
  startup: {
    readonly exportsAgent: boolean;
    readonly lines?: readonly string[];
  },
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
      ...(startup.lines ?? []),
    ].join("\n"),
  );
}

const exitHook = [
  'echo "error: a startup message" >&2',
  "trap 'echo goodbye; echo \"error: an exit message\" >&2' EXIT",
];

await test("CLV-344 an unsigned repository passes commit-signatures when the login file enables set -e", () =>
  withDoctor(async (scene) => {
    await savedHarness(scene, { kind: "shell", path: "claude_alias" });
    await writeFile(join(scene.root, ".bash_profile"), "set -e\n");
    const shown = check(
      await scene.report({ SHELL: "/bin/bash" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "ok");
    assert.equal(shown["detail"], "Commit signatures are off");
  }));

await test("CLV-344 a failed signer reports its error when the login file enables set -e", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: false, lines: ["set -e"] });
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

await test("CLV-344 with a login file that prints error lines and sets an exit hook, a turn that can sign gives ok, because the check reads only the output and the exit status of git", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: true, lines: exitHook });
    const shown = check(
      await scene.report({ SHELL: "/bin/bash" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "ok");
    assert.equal(shown["detail"], "A turn can sign commits (gpg.format ssh)");
  }));

await test("CLV-344 with a login file that prints error lines and sets an exit hook, a turn that cannot sign fails with the error line of git and is never read as off", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: false, lines: exitHook });
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

await test("CLV-344 a login file that ends the shell before the command fails the check and says that the login shell did not run git", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: true, lines: ["exit 3"] });
    const shown = check(
      await scene.report({ SHELL: "/bin/bash" }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "A turn cannot read commit.gpgsign: the login shell /bin/bash did not run git",
    );
  }));

await test("CLV-344 with a saved shell harness that exports the SSH agent, a profile with only another harness runs git with no shell, and the check names it when it cannot sign", () =>
  withDoctor(async (scene) => {
    await shellSigning(scene, { exportsAgent: true });
    const file = join(scene.root, "profiles.json");
    await writeFile(
      file,
      JSON.stringify({ profiles: { direct: { harness: "codex" } } }),
    );
    const shown = check(
      await scene.report({ SHELL: "/bin/bash", CLOVING_PROFILES: file }),
      "commit-signatures",
    );
    assert.equal(shown["result"], "fail");
    assert.equal(
      shown["detail"],
      "profile direct: A turn cannot sign commits (gpg.format ssh): error: signer: no SSH agent",
    );
  }));

await test("CLV-344 a login file that exports BASH_ENV gives the check no extra variables: a turn starts its harness from the login shell with no second shell, so an agent socket in the BASH_ENV file does not let the check sign", () =>
  withDoctor(async (scene) => {
    const environmentFile = join(scene.root, "bash-environment.sh");
    await writeFile(
      environmentFile,
      `export SSH_AUTH_SOCK='${join(scene.root, "agent.sock")}'\n`,
    );
    await shellSigning(scene, {
      exportsAgent: false,
      lines: [`export BASH_ENV='${environmentFile}'`],
    });
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
      profiles: {
        other: { harness: "codex", env: { NAME: "value" } },
        direct: { harness: "codex" },
      },
      boxed: [],
      problems: [],
    },
    harness: { name: "claude", kind, path: "claude_alias" },
  });
  return calls;
}

const configRead = ["git", "config", "--type=bool", "--get", "commit.gpgsign"];

await test("CLV-344 the test signature runs git in a marked frame in the one login shell call of a turn for a saved shell harness, and runs git directly for a file harness or a profile with another harness", async () => {
  const [shell = [], other, direct] = await signatureCalls("shell");
  assert.deepEqual(shell.slice(0, 4), ["/bin/zsh", "-l", "-i", "-c"]);
  assert.ok(String(shell[4]).startsWith(shellTurnPrelude));
  assert.notEqual(shell[4], shellTurnScript);
  assert.equal(shell[5], "cloving-harness");
  assert.equal(existsSync(String(shell[6])), false);
  assert.match(String(shell[7]), /^__CLOVING_GIT_\S+__$/);
  assert.deepEqual(shell.slice(8), configRead);
  assert.equal(shell.filter((part) => part === "/bin/zsh").length, 1);
  assert.deepEqual([other, direct], [configRead, configRead]);
  assert.deepEqual(await signatureCalls("file"), [configRead, configRead]);
});
