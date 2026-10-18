import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisAvailable } from "../src/daemon/analysis-launch.ts";
import { installAnalysisCli, withScene } from "./claude-worker-fixture.ts";

const required = [
  "--safe-mode",
  "--restricted",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
  "--tools",
  "--disallowedTools",
  "--mcp-config",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--permission-prompts",
  "--print",
  "--output-format",
  "--verbose",
  "--max-turns",
  "--max-budget-usd",
  "--model",
];

for (const [version, available] of [
  ["2.1.301 (Claude Code)", false],
  ["1.9.9 (Claude Code)", false],
  ["3.0.0 (Claude Code)", false],
  ["malformed", false],
  ["2.1.302 (Claude Code)", true],
  ["2.1.400 (Claude Code)", true],
  ["2.2.0 (Claude Code)", true],
  ["2.0.9999 (Claude Code)", false],
  ["2.1.302-beta (Claude Code)", false],
  ["02.1.302 (Claude Code)", false],
] as const) {
  await test("CLV-118 analysis CLI version compatibility: " + version, () =>
    withScene(async (scene) => {
      const restore = installAnalysisCli(scene, { reply: "{}", version });
      try {
        assert.equal(await analysisAvailable(scene.directory), available);
        assert.deepEqual(scene.turns(), []);
      } finally {
        restore();
      }
    }),
  );
}

for (const missing of required) {
  await test("CLV-118 analysis refuses help missing " + missing, () =>
    withScene(async (scene) => {
      const restore = installAnalysisCli(scene, {
        reply: "{}",
        help:
          required.filter((flag) => flag !== missing).join(" ") +
          " " +
          missing +
          "-different",
      });
      try {
        assert.equal(await analysisAvailable(scene.directory), false);
        assert.deepEqual(scene.turns(), []);
      } finally {
        restore();
      }
    }),
  );
}
