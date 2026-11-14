import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { probeHarness } from "../src/agent-harnesses.ts";
import { withDoctor, check } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import {
  parseConfiguration,
  resolveSettings,
} from "../src/project-settings.ts";
import { profileCommand } from "../src/turn-profile.ts";
import { turnHarness } from "../src/harness-defaults.ts";
import { commandUsage } from "../src/cli/usage.ts";

await test("CLV-366 Pi setup diagnoses unsupported versions without a provider call", () =>
  withDoctor(async (scene) => {
    const program = await scene.program(
      "pi",
      'if (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(91); console.log("1.5.3")',
    );
    const discovery = await probeHarness(program, { env: scene.environment });
    assert.equal(discovery.entries[0]?.reason, "unsupported-version");
    const initialized = initCli(scene, {
      arguments: ["--local", "--harness", program],
    });
    assert.notEqual(initialized.status, 0);
    assert.match(initialized.stderr, /unsupported-version/);
    const selected = check(
      await scene.report({
        CLOVING_WORKER: "pi",
        CLOVING_PI_COMMAND: JSON.stringify([program, "--mode", "json"]),
      }),
      "default-harness",
    );
    assert.equal(selected["result"], "fail");
    assert.match(String(selected["detail"]), /unsupported-version/);
  }));

await test("CLV-366 absent, shim and usable Pi entries preserve other setup paths", () =>
  withDoctor(async (scene) => {
    const absent = await probeHarness("pi", { env: scene.environment });
    assert.equal(absent.entries[0]?.reason, "not-found");
    assert.equal(
      initCli(scene, { arguments: ["--local", "--harness", "claude"] }).status,
      0,
    );
    await rm(join(scene.repository, ".cloving/workflows"), { recursive: true });
    const program = await scene.program(
      "pi",
      'if (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(91); console.log("Error: Pi 1.5.2 is unavailable")',
    );
    const shim = await probeHarness(program, { env: scene.environment });
    assert.equal(shim.entries[0]?.reason, "no-version");
    assert.match(
      initCli(scene, { arguments: ["--local", "--harness", program] }).stderr,
      /no-version/,
    );
    await scene.program(
      "pi",
      'if (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(91); console.log("1.5.2")',
    );
    const usable = await probeHarness(program, { env: scene.environment });
    assert.equal(usable.entries[0]?.working, true);
    assert.equal(
      initCli(scene, { arguments: ["--local", "--harness", program] }).status,
      0,
    );
  }));

await test("CLV-366 the harness guide separates Pi contract, CLI and provider evidence", async () => {
  const guide = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(guide, /### Pi capability qualification/);
  assert.match(guide, /Fake-process contract evidence/);
  assert.match(guide, /Real local CLI evidence/);
  assert.match(guide, /Separately authorized provider evidence/);
  assert.match(guide, /extension_ui_request/);
  assert.match(guide, /extension_ui_response/);
  assert.match(guide, /### Pi release checklist/);
  const section = guide.slice(
    guide.indexOf("### Pi capability qualification"),
    guide.indexOf("### Pi release checklist"),
  );
  const example = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
  assert.ok(example);
  const settings = parseConfiguration(example, "private");
  assert.ok(settings.harness);
  const selected = turnHarness(
    { harness: settings.harness },
    settings.profiles?.["pi"],
  );
  assert.equal(selected.worker, "pi");
  assert.ok(selected.command.includes("claude-sonnet-4-5"));
  assert.ok(
    profileCommand(selected.command, settings.profiles?.["pi"] ?? {}).includes(
      "anthropic/claude-sonnet-4-5",
    ),
  );
  const resolved = resolveSettings(
    {},
    { project: undefined, private: example },
  );
  assert.equal(resolved.environment["CLOVING_WORKER"], "pi");
  assert.equal(
    resolved.environment["CLOVING_PI_COMMAND"],
    JSON.stringify(settings.harness.command),
  );
  assert.match(commandUsage["start"] ?? "", /CLOVING_PI_COMMAND/);
  assert.match(commandUsage["steer"] ?? "", /Pi.*RPC/);
});

await test("CLV-366 an explicit shell Pi diagnoses its own version beside a usable file", () =>
  withDoctor(async (scene) => {
    await scene.program(
      "pi",
      'if (process.argv[2] !== "--version") process.exit(91); console.log("1.5.2")',
    );
    await writeFile(
      join(scene.root, ".zshrc"),
      'pi() { [[ "$#" = 1 && "$1" = --version ]] || return 91; echo 1.5.3; }\n',
    );
    const result = initCli(scene, {
      arguments: ["--local", "--harness", "shell:pi"],
      environment: { SHELL: "/bin/zsh" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported-version/);
    const discovery = await probeHarness("pi", {
      env: { ...scene.environment, SHELL: "/bin/zsh" },
    });
    assert.equal(
      discovery.entries.find((entry) => entry.kind === "file")?.working,
      true,
    );
    assert.equal(
      discovery.entries.find((entry) => entry.kind === "shell")?.reason,
      "unsupported-version",
    );
  }));
