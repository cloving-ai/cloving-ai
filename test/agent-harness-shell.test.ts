import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { discoverHarnesses, probeHarness } from "../src/agent-harnesses.ts";
import { harnessPid, withHarnesses } from "./agent-harness-fixture.ts";

function killHarness(identifier: number): void {
  try {
    process.kill(identifier, "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
  }
}

async function harnessStopped(identifier: number): Promise<boolean> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    try {
      process.kill(identifier, 0);
    } catch (error) {
      if (Reflect.get(Object(error), "code") === "ESRCH") return true;
      throw error;
    }
    await delay(20);
  }
  return false;
}

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  await test(`CLV-208 ${shell} functions and aliases are separate from files and ignore banners`, () =>
    withHarnesses(async (scene) => {
      const file = await scene.file("codex", 'printf "codex-cli 0.100.0\\n"');
      await scene.file(
        "alias-version",
        'test "$1" = --model && test "$2" = fast && test "$3" = --version && printf "2.1.0 (Claude Code)\\n"',
      );
      await scene.startup(
        `printf 'startup banner\\n'\nprintf 'start\\n' >> "$HOME/starts"\ncodex() { test "$1" = --version && printf 'codex-cli 0.101.0\\n'; }\nalias claude='"$HOME/alias-version" --model fast'\n`,
      );
      const result = await discoverHarnesses({
        env: { ...scene.options.env, SHELL: shell },
      });
      assert.equal(result.shellReason, null);
      assert.deepEqual(result.entries, [
        {
          name: "codex",
          kind: "file",
          path: file,
          version: "codex-cli 0.100.0",
          working: true,
          reason: null,
        },
        {
          name: "claude",
          kind: "shell",
          shellMode: "login",
          path: "claude",
          version: "2.1.0 (Claude Code)",
          working: true,
          reason: null,
        },
        {
          name: "codex",
          kind: "shell",
          shellMode: "login",
          path: "codex",
          version: "codex-cli 0.101.0",
          working: true,
          reason: null,
        },
      ]);
      assert.equal(
        (await readFile(join(scene.directory, "starts"), "utf8"))
          .split("\n")
          .filter(Boolean).length,
        3,
      );
    }));

  await test(`CLV-208 ${shell} receives hostile names only as arguments`, () =>
    withHarnesses(async (scene) => {
      const target = "agent; printf injected > injected; '";
      const wrapper = await scene.file(
        "fake-shell",
        `printf '%s\\n' "$@" > "$HOME/arguments"\ncd "$HOME"\nexec ${shell} "$@"`,
      );
      const result = await probeHarness(target, {
        env: { ...scene.options.env, SHELL: wrapper },
      });
      assert.equal(result.entries[0]?.reason, "not-found");
      assert.equal(
        (await readFile(join(scene.directory, "arguments"), "utf8"))
          .split("\n")
          .at(-2),
        target,
      );
      const argumentsText = await readFile(
        join(scene.directory, "arguments"),
        "utf8",
      );
      assert.equal(argumentsText.split(target).length, 2);
      await assert.rejects(readFile(join(scene.directory, "injected")), {
        code: "ENOENT",
      });
    }));
}

await test("CLV-208 shell failures yield no shell entries and retain the file results", () =>
  withHarnesses(async (scene) => {
    await scene.file("pi", 'printf "pi 1.2\\n"');
    await scene.startup("exit 7\n");
    const result = await discoverHarnesses(scene.options);
    assert.equal(result.shellReason, "probe-exit");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.working, true);
    const unavailable = await discoverHarnesses({
      env: { PATH: scene.directory, SHELL: "/missing/cloving-shell" },
    });
    assert.equal(unavailable.shellReason, "probe-start");
    assert.equal(unavailable.entries.length, 1);
    assert.equal(
      (await discoverHarnesses({ env: { PATH: scene.directory } })).shellReason,
      "shell-unavailable",
    );
  }));

await test("CLV-208 shell probes use first-line validation and preserve failures", () =>
  withHarnesses(async (scene) => {
    await scene.startup(
      `codex() { printf 'Error: requires Node 22\\ncodex-cli 0.1.0\\n'; }\nclaude() { printf '2.1.0 (Claude Code)\\n'; return 3; }\n`,
    );
    const result = await discoverHarnesses(scene.options);
    assert.deepEqual(
      result.entries.map(({ name, reason, working }) => ({
        name,
        reason,
        working,
      })),
      [
        { name: "claude", reason: "probe-exit", working: false },
        { name: "codex", reason: "no-version", working: false },
      ],
    );
  }));

await test("CLV-208 Other discovers a custom function and bypasses shell inspection for paths", () =>
  withHarnesses(async (scene) => {
    await scene.startup('other() { printf "Other 1.2\\n"; }\n');
    assert.deepEqual((await probeHarness("other", scene.options)).entries, [
      {
        name: "other",
        kind: "shell",
        shellMode: "login",
        path: "other",
        version: "Other 1.2",
        working: true,
        reason: null,
      },
    ]);
    const path = await scene.file("other", 'printf "Other 1.3\\n"');
    await scene.startup("exit 5\n");
    const result = await probeHarness(path, scene.options);
    assert.equal(result.entries[0]?.working, true);
    assert.equal(result.shellReason, null);
  }));

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  await test(`CLV-208 ${shell} expands a same-name alias exactly once`, () =>
    withHarnesses(async (scene) => {
      await scene.file(
        "claude",
        'test "$#" = 3 && test "$1" = --model && test "$2" = fast && test "$3" = --version && printf "2.1.0 (Claude Code)\\n"',
      );
      await scene.startup(
        "PATH=\"$HOME:$PATH\"\nalias claude='claude --model fast'\n",
      );
      const result = await discoverHarnesses({
        env: { ...scene.options.env, SHELL: shell },
      });
      assert.deepEqual(
        result.entries.find((entry) => entry.kind === "shell"),
        {
          name: "claude",
          kind: "shell",
          shellMode: "login",
          path: "claude",
          version: "2.1.0 (Claude Code)",
          working: true,
          reason: null,
        },
      );
    }));
}

await test("CLV-208 shell timeouts also stop startup and probe descendants", async () => {
  const cases = ["/bin/zsh", "/bin/bash"].flatMap((shell) =>
    ["startup", "probe"].map((mode) => ({ shell, mode })),
  );
  await Promise.all(
    cases.map(({ shell, mode }) =>
      withHarnesses(async (scene) => {
        const body =
          '/bin/sleep 30 & printf "%s\\n" "$!" > "$HOME/child"; wait;';
        await scene.startup(
          mode === "startup" ? body : `codex() { ${body} }\n`,
        );
        const result = await discoverHarnesses({
          env: { ...scene.options.env, SHELL: shell },
        });
        const child = harnessPid(
          await readFile(join(scene.directory, "child"), "utf8"),
        );
        try {
          const reason =
            mode === "startup" ? result.shellReason : result.entries[0]?.reason;
          assert.equal(reason, "probe-timeout");
          assert.equal(result.entries.length, mode === "startup" ? 0 : 1);
          assert.equal(
            result.shellReason,
            mode === "startup" ? "probe-timeout" : null,
          );
          assert.equal(await harnessStopped(child), true);
        } finally {
          killHarness(child);
        }
      }),
    ),
  );
});
