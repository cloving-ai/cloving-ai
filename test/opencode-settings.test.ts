import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationEntries } from "../src/configuration-display.ts";
import { resolveSettings } from "../src/project-settings.ts";

const settings = JSON.stringify({
  version: 1,
  harness: {
    name: "opencode",
    command: ["saved-opencode", "run", "--format", "json"],
  },
});

await test("CLV-212 opencode settings select only their own command variable", () => {
  const resolved = resolveSettings(
    {},
    { project: undefined, private: settings },
  );
  assert.equal(
    resolved.environment["CLOVING_OPENCODE_COMMAND"],
    '["saved-opencode","run","--format","json"]',
  );
  const entries = configurationEntries({
    project: undefined,
    private: settings,
    environment: {
      CLOVING_CLAUDE_COMMAND: '["wrong"]',
      CLOVING_OPENCODE_COMMAND: '["chosen"]',
    },
    field: "harness.command",
  });
  assert.deepEqual(entries[0]?.value, ["chosen"]);
  assert.equal(entries[0].source, "environment");
});

await test("CLV-212 configuration displays the opencode default command", () => {
  const entries = configurationEntries({
    project: undefined,
    private: undefined,
    environment: { CLOVING_WORKER: "opencode" },
    field: "harness.command",
  });
  assert.deepEqual(entries[0]?.value, ["opencode", "run", "--format", "json"]);
});
