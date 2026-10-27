import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSettings } from "../src/project-settings.ts";
import { configurationEntries } from "../src/configuration-display.ts";
import { defaultGrokCommand } from "../src/harness-defaults.ts";

await test("CLV-213 grok configuration resolves and displays its own saved command", () => {
  const saved = JSON.stringify({
    version: 1,
    harness: { name: "grok", command: ["saved-grok"] },
  });
  const resolved = resolveSettings({}, { project: undefined, private: saved });
  assert.equal(resolved.environment["CLOVING_GROK_COMMAND"], '["saved-grok"]');
  const entries = configurationEntries({
    project: undefined,
    private: undefined,
    environment: {
      CLOVING_WORKER: "grok",
      CLOVING_CLAUDE_COMMAND: '["unused"]',
    },
    field: "harness.command",
  });
  assert.deepEqual(entries[0]?.value, defaultGrokCommand);
  const overridden = configurationEntries({
    project: undefined,
    private: saved,
    environment: { CLOVING_GROK_COMMAND: '["override-grok"]' },
    field: "harness.command",
  });
  assert.deepEqual(overridden[0]?.value, ["override-grok"]);
});
