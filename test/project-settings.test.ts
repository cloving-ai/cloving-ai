import { configuration } from "../src/configuration-schema.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { settingsScene } from "./project-settings-fixture.ts";
import { test } from "node:test";
import { settingsEnvironment } from "../src/cli/project-settings.ts";

const mappedSettings = [
  ["project", "checks.beforeMerge", "CLOVING_CHECK_COMMAND", ["npm", "test"]],
  ["project", "checks.required", "CLOVING_REQUIRED_CHECKS", ["unit"]],
  ["project", "tickets.command", "CLOVING_TICKET_COMMAND", ["ticket"]],
  ["project", "tickets.nextCommand", "CLOVING_NEXT_COMMAND", ["next"]],
  ["project", "queue.everySeconds", "CLOVING_QUEUE_SECONDS", 20],
  ["project", "queue.lanes", "CLOVING_QUEUE_LANES", 2],
  ["project", "queue.dailySpendLimitUsd", "CLOVING_QUEUE_DAILY_SPEND_USD", 20],
  [
    "private",
    "queue.dailySpendLimitUsd",
    "CLOVING_QUEUE_DAILY_SPEND_USD",
    25.5,
  ],
  ["private", "harness.name", "CLOVING_WORKER", "codex"],
  ["private", "harness.command", "CLOVING_CLAUDE_COMMAND", ["custom-claude"]],
  ["private", "harness.command", "CLOVING_CODEX_COMMAND", ["custom-codex"]],
  ["private", "fallbackModels", "CLOVING_FALLBACK_MODELS", ["fallback"]],
  [
    "private",
    "tokenPrices",
    "CLOVING_TOKEN_PRICES",
    { model: { input: 1, cachedInput: 0, output: 2 } },
  ],
  ["private", "privateTexts", "CLOVING_PRIVATE_TEXTS", ["acme"]],
  ["private", "notify.command", "CLOVING_NOTIFY_COMMAND", ["notify"]],
  ["private", "watch.port", "CLOVING_WATCH_PORT", 4567],
  ["private", "watch.actions", "CLOVING_WATCH_ACTIONS", "off"],
  ["private", "selfUpdate.everySeconds", "CLOVING_SELF_UPDATE_SECONDS", 60],
  ["private", "github.command", "CLOVING_GH_COMMAND", ["github"]],
] as const;

for (const [scope, field, variable, value] of mappedSettings)
  await test(`CLV-205 ${variable} reads ${field} from its ${scope} file`, () => {
    const fixture = settingsScene();
    try {
      const [parent, child] = field.split(".");
      assert.ok(parent);
      const setting =
        child === undefined
          ? { [parent]: value }
          : { [parent]: { [child]: value } };
      if (field === "harness.command")
        Object.assign(setting, {
          harness: {
            name: variable === "CLOVING_CODEX_COMMAND" ? "codex" : "claude",
            command: value,
          },
        });
      const worker =
        variable === "CLOVING_CODEX_COMMAND" ? { CLOVING_WORKER: "codex" } : {};
      fixture.write(
        scope === "project" ? fixture.project : fixture.privateFile,
        { version: 1, ...setting },
      );
      const result = settingsEnvironment(
        { ...fixture.environment, ...worker },
        fixture.repository,
      );
      assert.equal(
        result[variable],
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

await test("CLV-205 environment overrides private overrides project at each field", () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.project, {
      version: 1,
      checks: { beforeMerge: ["project"], required: ["unit"] },
    });
    fixture.write(fixture.privateFile, {
      version: 1,
      checks: { beforeMerge: ["private"] },
    });
    const resolved = settingsEnvironment(
      fixture.environment,
      fixture.repository,
    );
    assert.equal(resolved["CLOVING_CHECK_COMMAND"], '["private"]');
    assert.equal(resolved["CLOVING_REQUIRED_CHECKS"], '["unit"]');
    assert.equal(
      settingsEnvironment(
        { ...fixture.environment, CLOVING_CHECK_COMMAND: '["environment"]' },
        fixture.repository,
      )["CLOVING_CHECK_COMMAND"],
      '["environment"]',
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-205 invalid configuration has fixed codes and field names", () => {
  const fixture = settingsScene();
  try {
    for (const [value, code] of [
      [
        { version: 1, privateTexts: ["secret"] },
        "private-setting-in-project-file: privateTexts",
      ],
      [{ version: 1, queue: { lane: 2 } }, "unknown-setting: queue.lane"],
      [{ version: 1, queue: { lanes: "2" } }, "invalid-setting: queue.lanes"],
      [{ version: 2 }, "unsupported-config-version: version"],
      [{}, "unsupported-config-version: version"],
      [{ version: 1, checks: null }, "invalid-setting: checks"],
      [
        { version: 1, CLOVING_RUNTIME_DIR: "somewhere" },
        "unknown-setting: CLOVING_RUNTIME_DIR",
      ],
    ] as const) {
      fixture.write(fixture.project, value);
      assert.throws(
        () => settingsEnvironment(fixture.environment, fixture.repository),
        { message: code },
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-241 spend configuration accepts only positive finite numbers", () => {
  for (const scope of ["project", "private"] as const) {
    for (const value of [0, -1, "20", Infinity, NaN])
      assert.throws(
        () =>
          configuration(
            { version: 1, queue: { dailySpendLimitUsd: value } },
            scope,
          ),
        /invalid-setting: queue.dailySpendLimitUsd/,
      );
    assert.equal(
      configuration({ version: 1, queue: { dailySpendLimitUsd: 0.01 } }, scope)
        .queue?.dailySpendLimitUsd,
      0.01,
    );
  }
});
