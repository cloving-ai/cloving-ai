import assert from "node:assert/strict";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { discoverHarnesses, probeHarness } from "../src/agent-harnesses.ts";
import { withHarnesses } from "./agent-harness-fixture.ts";

await test("CLV-208 a zero-exit broken shim has no version", () =>
  withHarnesses(async (scene) => {
    const path = await scene.file(
      "pi",
      'printf "Error: agent not installed\\n"',
    );
    const result = await discoverHarnesses(scene.options);
    assert.deepEqual(result.entries, [
      {
        name: "pi",
        kind: "file",
        path,
        version: null,
        working: false,
        reason: "no-version",
      },
    ]);
  }));

await test("CLV-208 every known file harness must emit its own first-line version", () =>
  withHarnesses(async (scene) => {
    const samples = [
      ["claude", "2.1.0 (Claude Code)"],
      ["codex", "codex-cli 0.104.0"],
      ["gemini", "0.30.0-preview.1"],
      ["opencode", "1.2.0"],
      ["grok", "0.0.19"],
      ["cursor-agent", "2025.09.12-4852336"],
      ["pi", "pi 0.50.0"],
      ["amp", "amp 0.1.0"],
    ];
    for (const [name = "", version = ""] of samples)
      await scene.file(
        name,
        `test "$1" = --version && ! read -r input && printf '%s\\n' '${version}'`,
      );
    const result = await discoverHarnesses(scene.options);
    assert.deepEqual(
      result.entries.map(({ name, version, working, reason }) => ({
        name,
        version,
        working,
        reason,
      })),
      samples.map(([name, version]) => ({
        name,
        version,
        working: true,
        reason: null,
      })),
    );
  }));

await test("CLV-208 exit zero cannot disguise error text or a later version line", () =>
  withHarnesses(async (scene) => {
    for (const [name, body] of [
      ["claude", 'printf "Error: requires Node 22\\n2.1.0 (Claude Code)\\n"'],
      ["codex", 'printf "2.1.0 (Claude Code)\\n"'],
      ["pi", 'printf "Error: requires Node 22\\n"'],
      ["amp", 'printf "amp 0.1.0 UnAvAiLaBlE\\n"'],
    ])
      await scene.file(name ?? "", body ?? "");
    const result = await discoverHarnesses(scene.options);
    assert.equal(result.entries.length, 4);
    assert.ok(
      result.entries.every(
        (entry) =>
          !entry.working &&
          entry.reason === "no-version" &&
          entry.version === null,
      ),
    );
  }));

await test("CLV-208 a nonzero exit or an unstartable executable fails its probe", () =>
  withHarnesses(async (scene) => {
    await scene.file("claude", 'printf "2.1.0 (Claude Code)\\n"; exit 2');
    const broken = join(scene.directory, "codex");
    await symlink("/missing/cloving-agent", broken);
    const result = await discoverHarnesses(scene.options);
    assert.equal(result.entries[0]?.reason, "probe-exit");
    assert.equal(result.entries[0].working, false);
    const missing = await probeHarness(broken, scene.options);
    assert.equal(missing.entries[0]?.reason, "not-found");
  }));

await test("CLV-208 Other probes a literal name or path with the fallback version rule", () =>
  withHarnesses(async (scene) => {
    const path = await scene.file("other; 'agent", 'printf "custom 1.2\\n"');
    for (const target of [path, "other; 'agent"])
      assert.deepEqual((await probeHarness(target, scene.options)).entries, [
        {
          name: "other; 'agent",
          kind: "file",
          path,
          version: "custom 1.2",
          working: true,
          reason: null,
        },
      ]);
    for (const output of [
      "ERROR 1.2",
      "1.2 unavailable",
      "1.2 Not Found",
      "no version",
    ]) {
      await scene.file("other", `printf '%s\\n' '${output}'`);
      assert.equal(
        (await probeHarness("other", scene.options)).entries[0]?.reason,
        "no-version",
      );
    }
  }));

await test("CLV-208 PATH chooses its first executable file and skips directories and nonexecutables", () =>
  withHarnesses(async (scene) => {
    await mkdir(join(scene.directory, "claude"));
    const nonExecutable = await scene.file(
      "codex",
      'printf "codex-cli 0.1.0\\n"',
    );
    await chmod(nonExecutable, 0o644);
    const second = join(scene.directory, "second");
    await mkdir(second);
    const path = await scene.file(
      "second/codex",
      'printf "codex-cli 0.2.0\\n"',
    );
    const result = await discoverHarnesses({
      env: { PATH: `${scene.directory}:${second}` },
    });
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      [path],
    );
  }));

await test("CLV-208 file probes stop at ten seconds", () =>
  withHarnesses(async (scene) => {
    await scene.file("pi", '/bin/sleep 30; printf "pi 1.2\\n"');
    const began = performance.now();
    const result = await discoverHarnesses(scene.options);
    const elapsed = performance.now() - began;
    assert.ok(elapsed >= 10000 && elapsed < 15000);
    assert.deepEqual(
      result.entries.map(({ reason, working }) => ({ reason, working })),
      [{ reason: "probe-timeout", working: false }],
    );
  }));

await test("CLV-208 file probes bound output", () =>
  withHarnesses(async (scene) => {
    await scene.file("amp", "printf '%070000d' 1");
    const result = await discoverHarnesses(scene.options);
    assert.equal(result.entries[0]?.reason, "probe-output-limit");
    assert.equal(result.entries[0].working, false);
  }));

await test("CLV-208 OpenCode accepts its current branded version output", () =>
  withHarnesses(async (scene) => {
    await scene.file("opencode", 'printf "opencode v2.1.4\\n"');
    const result = await discoverHarnesses(scene.options);
    assert.equal(result.entries[0]?.version, "opencode v2.1.4");
    assert.equal(result.entries[0].working, true);
  }));
