import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { configuration } from "../src/configuration-schema.ts";
import { resolveSettings } from "../src/project-settings.ts";
import type { TurnProfiles } from "../src/turn-profile.ts";
import type { TokenPrices } from "../src/token-prices.ts";
import {
  projectSettings,
  settingsEnvironment,
} from "../src/cli/project-settings.ts";
import { settingsScene } from "./project-settings-fixture.ts";

await test("CLV-205 validated configuration preserves concrete setting types", () => {
  const checked = configuration(
    {
      version: 1,
      checks: { beforeMerge: ["npm", "test"] },
      queue: { lanes: 2 },
      harness: { name: "claude" },
      profiles: { checker: { model: "small" } },
      tokenPrices: { model: { input: 1, cachedInput: 0, output: 2 } },
    },
    "private",
  );
  const command: readonly string[] | undefined = checked.checks?.beforeMerge;
  const lanes: number | undefined = checked.queue?.lanes;
  const harness: string | undefined = checked.harness?.name;
  const profiles: TurnProfiles | undefined = checked.profiles;
  const prices: TokenPrices | undefined = checked.tokenPrices;
  assert.deepEqual(command, ["npm", "test"]);
  assert.equal(lanes, 2);
  assert.equal(harness, "claude");
  assert.deepEqual(profiles, { checker: { model: "small" } });
  assert.deepEqual(prices, {
    model: { input: 1, cachedInput: 0, output: 2 },
  });
});

await test("CLV-210 private harness commands stay with their named harness", () => {
  const result = resolveSettings(
    { CLOVING_WORKER: "claude" },
    {
      project: undefined,
      private: JSON.stringify({
        version: 1,
        harness: { name: "codex", command: ["private-codex"] },
      }),
    },
  );
  assert.equal(result.environment["CLOVING_CLAUDE_COMMAND"], undefined);
  assert.equal(
    result.environment["CLOVING_CODEX_COMMAND"],
    '["private-codex"]',
  );
});

await test("CLV-210 unsupported saved harness commands never become Claude overrides", () => {
  const result = resolveSettings(
    { CLOVING_WORKER: "claude" },
    {
      project: undefined,
      private: JSON.stringify({
        version: 1,
        harness: { name: "unsupported", command: ["private-unsupported"] },
      }),
    },
  );
  assert.equal(result.environment["CLOVING_CLAUDE_COMMAND"], undefined);
});

await test("CLV-211 saved Gemini commands resolve with their own environment source", () => {
  const files = {
    project: undefined,
    private: JSON.stringify({
      version: 1,
      harness: { name: "gemini", command: ["private-gemini"] },
    }),
  };
  const saved = resolveSettings({}, files);
  assert.equal(
    saved.environment["CLOVING_GEMINI_COMMAND"],
    '["private-gemini"]',
  );
  assert.equal(saved.environment["CLOVING_CLAUDE_COMMAND"], undefined);
  const overridden = resolveSettings(
    { CLOVING_GEMINI_COMMAND: '["environment-gemini"]' },
    files,
  );
  assert.equal(
    overridden.environment["CLOVING_GEMINI_COMMAND"],
    '["environment-gemini"]',
  );
  assert.equal(overridden.sources["harness.command"], "environment");
});

await test("CLV-210 configuration permits named harnesses and profile overrides", () => {
  const harness = { name: "gemini", kind: "shell", path: "gemini" };
  const profiles = { checker: { harness: "claude", model: "small" } };
  const checked = configuration({ version: 1, harness, profiles }, "private");
  assert.deepEqual(checked.harness, harness);
  assert.deepEqual(checked.profiles, profiles);
});

await test("CLV-205 a relative XDG config root uses the home configuration directory", () => {
  const fixture = settingsScene();
  try {
    const privateFile = join(
      fixture.environment.HOME,
      ".config/cloving/projects",
      basename(fixture.privateFile),
    );
    fixture.write(privateFile, { version: 1, privateTexts: ["home"] });
    const result = settingsEnvironment(
      { ...fixture.environment, XDG_CONFIG_HOME: "relative" },
      fixture.repository,
    );
    assert.equal(result["CLOVING_PRIVATE_TEXTS"], '["home"]');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-205 command overrides belong to the selected harness", () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.privateFile, {
      version: 1,
      harness: {
        name: "claude",
        kind: "shell",
        path: "agent",
        command: ["file-command"],
      },
    });
    const environment = {
      ...fixture.environment,
      CLOVING_CODEX_COMMAND: '["wrong"]',
    };
    assert.equal(
      settingsEnvironment(environment, fixture.repository)[
        "CLOVING_CLAUDE_COMMAND"
      ],
      '["file-command"]',
    );
    assert.equal(
      settingsEnvironment(
        { ...environment, CLOVING_CLAUDE_COMMAND: '["right"]' },
        fixture.repository,
      )["CLOVING_CLAUDE_COMMAND"],
      '["right"]',
    );
    assert.equal(
      settingsEnvironment(
        { ...environment, CLOVING_WORKER: "codex" },
        fixture.repository,
      )["CLOVING_CODEX_COMMAND"],
      '["wrong"]',
    );
    assert.equal(
      projectSettings(environment, fixture.repository).sources[
        "harness.command"
      ],
      "private",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-205 no configuration files preserve environment and built-in defaults", () => {
  const fixture = settingsScene();
  try {
    assert.deepEqual(projectSettings(fixture.environment, fixture.repository), {
      environment: fixture.environment,
      profiles: {},
      sources: {},
    });
    const environment = {
      ...fixture.environment,
      CLOVING_CHECK_COMMAND: "[]",
      CLOVING_WATCH_ACTIONS: "off",
    };
    const result = projectSettings(environment, fixture.repository);
    assert.deepEqual(result.environment, environment);
    assert.deepEqual(result.sources, {
      "checks.beforeMerge": "environment",
      "watch.actions": "environment",
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-205 private schema validates nested fields and preserves profiles", () => {
  const fixture = settingsScene();
  try {
    const profiles = {
      checker: { model: "small", env: { CUSTOM: "value" }, maxBudgetUsd: 1 },
    };
    fixture.write(fixture.privateFile, { version: 1, profiles });
    assert.deepEqual(
      projectSettings(fixture.environment, fixture.repository).profiles,
      profiles,
    );
    for (const [value, code] of [
      [{ harness: { kind: "executable" } }, "invalid-setting: harness.kind"],
      [{ harness: { path: 1 } }, "invalid-setting: harness.path"],
      [
        { profiles: { checker: { extra: 1 } } },
        "unknown-setting: profiles.checker.extra",
      ],
      [
        { profiles: { checker: { env: { GH_TOKEN: "forbidden" } } } },
        "invalid-setting: profiles.checker.env.GH_TOKEN",
      ],
      [{ watch: { port: 65536 } }, "invalid-setting: watch.port"],
      [{ watch: { actions: true } }, "invalid-setting: watch.actions"],
      [{ fallbackModels: [" "] }, "invalid-setting: fallbackModels.0"],
      [
        { fallbackModels: ["a", "b", "c", "d"] },
        "invalid-setting: fallbackModels",
      ],
      [
        { tokenPrices: { model: { input: -1, cachedInput: 0, output: 1 } } },
        "invalid-setting: tokenPrices.model.input",
      ],
      [
        { tokenPrices: { model: { input: 1 } } },
        "invalid-setting: tokenPrices.model.cachedInput",
      ],
      [
        { checks: { beforeMerge: [1] } },
        "invalid-setting: checks.beforeMerge.0",
      ],
      [
        { selfUpdate: { everySeconds: 0 } },
        "invalid-setting: selfUpdate.everySeconds",
      ],
      [{ CLOVING_HOST_BOUND: 2 }, "unknown-setting: CLOVING_HOST_BOUND"],
    ] as const) {
      fixture.write(fixture.privateFile, { version: 1, ...value });
      assert.throws(
        () => projectSettings(fixture.environment, fixture.repository),
        { message: code },
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-205 malformed and unreadable files fail closed", () => {
  const fixture = settingsScene();
  try {
    writeFileSync(fixture.project, "{");
    assert.throws(
      () => projectSettings(fixture.environment, fixture.repository),
      { message: "invalid-config-json: project" },
    );
    rmSync(fixture.project);
    mkdirSync(fixture.project);
    assert.throws(
      () => projectSettings(fixture.environment, fixture.repository),
      /unreadable-config-file: project/,
    );
    rmSync(fixture.project, { recursive: true });
    mkdirSync(dirname(fixture.privateFile), { recursive: true });
    writeFileSync(fixture.privateFile, "null");
    assert.throws(
      () => projectSettings(fixture.environment, fixture.repository),
      { message: "invalid-setting: $" },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-205 the start guide attributes environment-only settings", () => {
  const fixture = settingsScene();
  try {
    const environment = {
      ...fixture.environment,
      CLOVING_RUNTIME_DIR: "runtime",
      CLOVING_OWNERSHIP_LEASE_SECONDS: "15",
      CLOVING_HOST_BOUND: "8",
      CLOVING_WATCH_REPOSITORY: "repository",
    };
    const { sources } = projectSettings(environment, fixture.repository);
    for (const name of [
      "CLOVING_RUNTIME_DIR",
      "CLOVING_OWNERSHIP_LEASE_SECONDS",
      "CLOVING_HOST_BOUND",
      "CLOVING_WATCH_REPOSITORY",
    ])
      assert.equal(sources[name], "environment");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
