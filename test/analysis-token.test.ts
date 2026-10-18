import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { analysisToken } from "../src/daemon/analysis-token.ts";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import {
  installAnalysisCli,
  intent,
  withScene,
} from "./claude-worker-fixture.ts";

const analysis = intent({ method: "run-turn:analyze-chats", target: importId });
const settings = {
  workflowId: () => Promise.resolve("analyze-chats"),
  document: () =>
    Promise.resolve(
      JSON.stringify({
        snapshot: {
          importId,
          corpus,
          redaction: JSON.stringify(manifest),
          structure: JSON.stringify(sidecar),
        },
      }),
    ),
};
const command = (source: string) =>
  JSON.stringify([process.execPath, "-e", source]);
const cases: readonly (readonly [string, string | undefined, string])[] = [
  ["unset", undefined, "unset"],
  ["invalid JSON", "[", "invalid"],
  ["empty array", "[]", "invalid"],
  ["non-array", "{}", "invalid"],
  ["non-string entry", '["node",2]', "invalid"],
  [
    "empty string entry",
    JSON.stringify([
      process.execPath,
      "-e",
      'process.stdout.write("token")',
      "",
    ]),
    "invalid",
  ],
  ["invalid program", JSON.stringify(["invalid\0program"]), "failed"],
  ["missing program", '["cloving-absent-token-command"]', "failed"],
  [
    "failed command",
    command(
      'process.stdout.write("synthetic-secret"); process.stderr.write("synthetic-secret"); process.exit(7)',
    ),
    "failed",
  ],
  [
    "slow command",
    command(
      'process.on("SIGTERM", () => {}); setTimeout(() => process.stdout.write("late-token"), 11000)',
    ),
    "timeout",
  ],
  [
    "stdout limit",
    command('process.stdout.write("x".repeat(4097))'),
    "output-too-large",
  ],
  [
    "stderr limit",
    command(
      'process.stderr.write("x".repeat(4097)); process.stdout.write("token")',
    ),
    "output-too-large",
  ],
  [
    "combined output limit",
    command(
      'process.stdout.write("x".repeat(512)); process.stderr.write("x".repeat(3585))',
    ),
    "output-too-large",
  ],
  ["empty output", command('process.stdout.write("")'), "output-invalid"],
  ["spaces", command('process.stdout.write("two tokens")'), "output-invalid"],
  [
    "multiple lines",
    command('process.stdout.write("one\\ntwo\\n")'),
    "output-invalid",
  ],
  [
    "two final line breaks",
    command('process.stdout.write("token\\n\\n")'),
    "output-invalid",
  ],
  [
    "token size",
    command('process.stdout.write("x".repeat(513))'),
    "output-invalid",
  ],
  [
    "control character",
    command('process.stdout.write("token\\t")'),
    "output-invalid",
  ],
  ["non-ASCII", command('process.stdout.write("tökén")'), "output-invalid"],
];

for (const [name, setting, category] of cases) {
  await test("CLV-118 token command refuses before a turn: " + name, () =>
    withScene(async (scene) => {
      const restore = installAnalysisCli(scene, { reply: "{}" });
      try {
        if (setting === undefined)
          delete process.env["CLOVING_ANALYSIS_TOKEN_COMMAND"];
        else process.env["CLOVING_ANALYSIS_TOKEN_COMMAND"] = setting;
        const outcome = await scene
          .worker("bare", settings)
          .deliver(analysis, new AbortController().signal);
        assert.deepEqual(outcome, {
          kind: "failed",
          reason: "analysis-worker-unavailable",
          result: JSON.stringify({
            error: "analysis-token-command-" + category,
          }),
        });
        assert.deepEqual(scene.turns(), []);
        assert.deepEqual(scene.reports, []);
        assert.equal(existsSync(join(scene.journal, "turn.stderr.log")), false);
      } finally {
        restore();
      }
    }),
  );
}

await test("CLV-118 literal command arguments, final line breaks and the exact byte boundaries are accepted", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, { reply: "{}" });
    try {
      for (const output of [
        "literal;$(false)",
        "token\n",
        "token\r\n",
        "token\r",
        "x".repeat(512),
      ]) {
        process.env["CLOVING_ANALYSIS_TOKEN_COMMAND"] = JSON.stringify([
          process.execPath,
          "-e",
          'process.stdout.write(process.argv[1]); process.stderr.write("e".repeat(4096 - Buffer.byteLength(process.argv[1])))',
          output,
        ]);
        assert.deepEqual(await analysisToken(scene.directory), {
          token: output.replace(/(?:\r\n|[\r\n])$/, ""),
        });
      }
      assert.deepEqual(scene.turns(), []);
    } finally {
      restore();
    }
  }));
