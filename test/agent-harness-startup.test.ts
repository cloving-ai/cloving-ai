import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { discoverHarnesses, probeHarness } from "../src/agent-harnesses.ts";
import { withHarnesses } from "./agent-harness-fixture.ts";

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  await test(`CLV-208 ${shell} tolerates missing lookups with startup errexit enabled`, () =>
    withHarnesses(async (scene) => {
      await scene.startup(
        'set -e\ncodex() { test "$1" = --version && printf "codex-cli 0.106.0\\n"; }\n',
      );
      const result = await discoverHarnesses({
        env: { ...scene.options.env, SHELL: shell },
      });
      assert.equal(result.shellReason, null);
      assert.deepEqual(result.entries, [
        {
          name: "codex",
          kind: "shell",
          shellMode: "login",
          path: "codex",
          version: "codex-cli 0.106.0",
          working: true,
          reason: null,
        },
      ]);
    }));
}

await test("CLV-208 a failed zsh startup is not retried as Bash", () =>
  withHarnesses(async (scene) => {
    await scene.startup('printf "start\\n" >> "$HOME/starts"\nexit 7\n');
    const result = await discoverHarnesses(scene.options);
    assert.equal(result.shellReason, "probe-exit");
    assert.deepEqual(result.entries, []);
    assert.equal(
      await readFile(join(scene.directory, "starts"), "utf8"),
      "start\n",
    );
  }));

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  await test(`CLV-208 ${shell} preserves the startup environment for discovered files without duplicate probes`, () =>
    withHarnesses(async (scene) => {
      await mkdir(join(scene.directory, "agents"));
      const path = await scene.file(
        "agents/codex",
        'printf "probe\\n" >> "$HOME/probes"\ntest "$1" = --version && test "$PATH" = "$HOME/agents:$HOME" && test "$NODE_OPTIONS" = --no-warnings && test "$LD_LIBRARY_PATH" = "$HOME/lib" && printf "codex-cli 0.101.0\\n"',
      );
      await scene.startup(
        'PATH="$HOME/agents:$HOME"\nexport NODE_OPTIONS=--no-warnings LD_LIBRARY_PATH="$HOME/lib"\n',
      );
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

for (const [failure, reason] of [
  ["/bin/sleep 30", "probe-timeout"],
  ["printf '%070000d' 1", "probe-output-limit"],
] as const) {
  await test(`CLV-208 shell startup repairs a caller PATH file after ${reason}`, async () => {
    await Promise.all(
      ["/bin/zsh", "/bin/bash"].map((shell) =>
        withHarnesses(async (scene) => {
          const path = await scene.file(
            "codex",
            `printf 'probe\\n' >> "$HOME/probes"\nif test "\${HARNESS_READY-}" != yes; then ${failure}; exit; fi\ntest "$1" = --version && printf 'codex-cli 0.108.0\\n'`,
          );
          await scene.startup('PATH="$HOME"\nexport HARNESS_READY=yes\n');
          const result = await discoverHarnesses({
            env: { ...scene.options.env, SHELL: shell },
          });
          assert.equal(result.shellReason, null);
          assert.deepEqual(result.entries, [
            {
              name: "codex",
              kind: "file",
              path,
              version: "codex-cli 0.108.0",
              working: true,
              reason: null,
            },
          ]);
          assert.equal(
            await readFile(join(scene.directory, "probes"), "utf8"),
            "probe\nprobe\n",
          );
        }),
      ),
    );
  });
}

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
        shellMode: "interactive",
        path: "codex",
        version: "codex-cli 0.104.0",
        working: true,
        reason: null,
      },
    ]);
  }));

for (const [startup, reason] of [
  ["exit 0\n", "shell-protocol"],
  ["exit 7\n", "probe-exit"],
  ["/bin/sleep 30\n", "probe-timeout"],
] as const) {
  await test(`CLV-208 Bash discovers interactive agents after login reports ${reason}`, () =>
    withHarnesses(async (scene) => {
      const path = await scene.file("pi", 'printf "pi 1.2\\n"');
      await scene.startup(startup);
      await writeFile(
        join(scene.directory, ".bashrc"),
        'codex() { test "$1" = --version && printf "codex-cli 0.107.0\\n"; }\n',
      );
      const result = await discoverHarnesses({
        env: { ...scene.options.env, SHELL: "/bin/bash" },
      });
      assert.equal(result.shellReason, reason);
      assert.deepEqual(result.entries, [
        {
          name: "pi",
          kind: "file",
          path,
          version: "pi 1.2",
          working: true,
          reason: null,
        },
        {
          name: "codex",
          kind: "shell",
          shellMode: "interactive",
          path: "codex",
          version: "codex-cli 0.107.0",
          working: true,
          reason: null,
        },
      ]);
    }));
}

for (const [startup, reason] of [
  ["exit 0\n", "shell-protocol"],
  ["exit 7\n", "probe-exit"],
  ["/bin/sleep 30\n", "probe-timeout"],
] as const) {
  await test(`CLV-208 Bash retains login entries when the extra scan reports ${reason}`, () =>
    withHarnesses(async (scene) => {
      const path = await scene.file("pi", 'printf "pi 1.2\\n"');
      await scene.startup(
        'codex() { test "$1" = --version && printf "codex-cli 0.105.0\\n"; }\n',
      );
      await writeFile(join(scene.directory, ".bashrc"), startup);
      const result = await discoverHarnesses({
        env: { ...scene.options.env, SHELL: "/bin/bash" },
      });
      assert.equal(result.shellReason, reason);
      assert.deepEqual(result.entries, [
        {
          name: "pi",
          kind: "file",
          path,
          version: "pi 1.2",
          working: true,
          reason: null,
        },
        {
          name: "codex",
          kind: "shell",
          shellMode: "login",
          path: "codex",
          version: "codex-cli 0.105.0",
          working: true,
          reason: null,
        },
      ]);
    }));
}
