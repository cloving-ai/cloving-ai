import assert from "node:assert/strict";
import { test } from "node:test";
import { configurationEntries } from "../src/configuration-display.ts";
import { defaultCursorCommand } from "../src/harness-defaults.ts";

await test("CLV-214 Cursor configuration shows its own default and ignores other worker command variables", () => {
  for (const environment of [
    {},
    {
      CLOVING_CLAUDE_COMMAND: '["wrong-claude"]',
      CLOVING_CODEX_COMMAND: '["wrong-codex"]',
    },
  ])
    assert.deepEqual(
      configurationEntries({
        project: undefined,
        private: JSON.stringify({
          version: 1,
          harness: { name: "cursor-agent" },
        }),
        environment,
        field: "harness.command",
      }),
      [
        {
          field: "harness.command",
          value: defaultCursorCommand,
          source: "default",
          hidden: [],
        },
      ],
    );
  assert.deepEqual(
    configurationEntries({
      project: undefined,
      private: JSON.stringify({
        version: 1,
        harness: { name: "cursor-agent", command: ["saved-cursor"] },
      }),
      environment: { CLOVING_CLAUDE_COMMAND: '["wrong-claude"]' },
      field: "harness.command",
    }),
    [
      {
        field: "harness.command",
        value: ["saved-cursor"],
        source: "private",
        hidden: [],
      },
    ],
  );
});
