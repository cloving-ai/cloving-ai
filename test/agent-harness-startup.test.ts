import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { discoverHarnesses, probeHarness } from "../src/agent-harnesses.ts";
import { withHarnesses } from "./agent-harness-fixture.ts";

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  await test(`CLV-208 ${shell} finds executable files added by shell startup without duplicate probes`, () =>
    withHarnesses(async (scene) => {
      await mkdir(join(scene.directory, "agents"));
      const path = await scene.file(
        "agents/codex",
        'printf "probe\\n" >> "$HOME/probes"\ntest "$1" = --version && test "$PATH" = "$HOME/agents:$HOME" && printf "codex-cli 0.101.0\\n"',
      );
      await scene.startup('PATH="$HOME/agents:$HOME"\n');
      const result = await discoverHarnesses({
        env: { ...scene.options.env, SHELL: shell },
      });
      assert.equal(result.shellReason, null);
      assert.deepEqual(result.entries, [
        {
          name: "codex",
          kind: "file",
          path,
          version: "codex-cli 0.101.0",
          working: true,
          reason: null,
        },
      ]);
      assert.equal(
        await readFile(join(scene.directory, "probes"), "utf8"),
        "probe\n",
      );
    }));
}

await test("CLV-208 shell PATH files and shell functions remain separate while caller PATH files are deduplicated", () =>
  withHarnesses(async (scene) => {
    const path = await scene.file("codex", 'printf "codex-cli 0.100.0\\n"');
    await scene.startup('codex() { printf "codex-cli 0.101.0\\n"; }\n');
    const result = await probeHarness("codex", scene.options);
    assert.deepEqual(
      result.entries.map(({ kind, path: entryPath }) => ({
        kind,
        path: entryPath,
      })),
      [
        { kind: "file", path },
        { kind: "shell", path: "codex" },
      ],
    );
  }));

await test("CLV-208 Bash discovers and probes bashrc-only aliases and functions", () =>
  withHarnesses(async (scene) => {
    await writeFile(join(scene.directory, ".bash_profile"), "");
    await scene.file(
      "alias-version",
      'test "$1" = --model && test "$2" = fast && test "$3" = --version && printf "2.1.0 (Claude Code)\\n"',
    );
    await writeFile(
      join(scene.directory, ".bashrc"),
      'printf "bashrc banner\\n"\ncodex() { test "$1" = --version && printf "codex-cli 0.102.0\\n"; }\nalias claude=\'"$HOME/alias-version" --model fast\'\n',
    );
    const result = await discoverHarnesses({
      env: { ...scene.options.env, SHELL: "/bin/bash" },
    });
    assert.equal(result.shellReason, null);
    assert.deepEqual(
      result.entries.map(({ name, kind, version, working }) => ({
        name,
        kind,
        version,
        working,
      })),
      [
        {
          name: "claude",
          kind: "shell",
          version: "2.1.0 (Claude Code)",
          working: true,
        },
        {
          name: "codex",
          kind: "shell",
          version: "codex-cli 0.102.0",
          working: true,
        },
      ],
    );
  }));

await test("CLV-208 retries an unusable caller PATH file with its shell PATH", () =>
  withHarnesses(async (scene) => {
    const path = await scene.file(
      "codex",
      'test "$PATH" = "$HOME:/bin" && printf "codex-cli 0.103.0\\n"',
    );
    await scene.startup('PATH="$HOME:/bin"\n');
    const result = await probeHarness("codex", scene.options);
    assert.equal(result.shellReason, null);
    assert.deepEqual(result.entries, [
      {
        name: "codex",
        kind: "file",
        path,
        version: "codex-cli 0.103.0",
        working: true,
        reason: null,
      },
    ]);
  }));

await test("CLV-208 Bash retries a failed login definition in its interactive startup mode", () =>
  withHarnesses(async (scene) => {
    await scene.startup('codex() { printf "Error: unavailable\\n"; }\n');
    await writeFile(
      join(scene.directory, ".bashrc"),
      'codex() { test "$1" = --version && printf "codex-cli 0.104.0\\n"; }\n',
    );
    const result = await probeHarness("codex", {
      env: { ...scene.options.env, SHELL: "/bin/bash" },
    });
    assert.equal(result.shellReason, null);
    assert.deepEqual(result.entries, [
      {
        name: "codex",
        kind: "shell",
        path: "codex",
        version: "codex-cli 0.104.0",
        working: true,
        reason: null,
      },
    ]);
  }));
