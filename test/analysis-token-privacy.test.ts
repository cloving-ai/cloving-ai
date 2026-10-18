import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(join(import.meta.dirname, name)).href);
const token = "synthetic-subscription-token";
const scenario = `
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { corpus, importId, manifest, sidecar } from ${moduleUrl("chats-worker-fixture.ts")};
import { installAnalysisCli, intent, until, withScene } from ${moduleUrl("claude-worker-fixture.ts")};
const mode = process.argv[1];
const token = ${JSON.stringify(token)};
const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const journalText = (folder) => readdirSync(folder, { withFileTypes: true }).map((entry) => {
  const path = join(folder, entry.name);
  return entry.isDirectory() ? journalText(path) : readFileSync(path, "utf8");
}).join("\\n");
await withScene(async (scene) => {
  const restore = installAnalysisCli(scene, { reply: "{}", mode });
  try {
    if (mode === "failed-command") process.env.CLOVING_ANALYSIS_TOKEN_COMMAND = JSON.stringify([
      process.execPath, "-e", 'process.stdout.write("synthetic-subscription-token"); process.stderr.write("synthetic-subscription-token"); process.exit(9)',
    ]);
    const outcome = await scene.worker("bare", {
      workflowId: () => Promise.resolve("analyze-chats"),
      document: () => Promise.resolve(JSON.stringify({ snapshot: {
        importId, corpus, redaction: JSON.stringify(manifest), structure: JSON.stringify(sidecar),
      } })),
    }).deliver(intent({ method: "run-turn:analyze-chats", target: importId }), new AbortController().signal);
    if (mode === "echo-token") await until(() => scene.reports.length === 1);
    const surfaces = JSON.stringify({ outcome, reports: scene.reports }) + journalText(scene.journal);
    console.log(JSON.stringify({ safe: !surfaces.includes(token), unchanged: process.env.CLAUDE_CODE_OAUTH_TOKEN === before, turns: scene.turns().length }));
  } finally { restore(); }
});
`;

for (const mode of ["echo-token", "failed-command"]) {
  await test(
    "CLV-118 credentials stay out of console, journal, logs, reports and errors: " +
      mode,
    () => {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", scenario, mode],
        { encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal((result.stdout + result.stderr).includes(token), false);
      assert.deepEqual(JSON.parse(result.stdout), {
        safe: true,
        unchanged: true,
        turns: mode === "echo-token" ? 1 : 0,
      });
    },
  );
}
