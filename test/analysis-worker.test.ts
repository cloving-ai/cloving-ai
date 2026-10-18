import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidate } from "./chats-analysis-fixture.ts";
import { importId, corpus, manifest, sidecar } from "./chats-worker-fixture.ts";
import {
  installAnalysisCli,
  intent,
  journalKey,
  resultOf,
  until,
  withScene,
  type TurnRecord,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const analysis = intent({ method: "run-turn:analyze-chats", target: importId });
const snapshot = {
  importId,
  corpus,
  redaction: JSON.stringify(manifest),
  structure: JSON.stringify(sidecar),
};

await test("CLV-116 replay cleans temporary analysis files before returning a durable result", () =>
  withScene(async (scene) => {
    const folder = join(scene.journal, journalKey(analysis.operationId));
    for (const name of ["configuration", "working"]) {
      mkdirSync(join(folder, name), { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, name, "temporary"), "private turn data", {
        mode: 0o600,
      });
    }
    const result = JSON.stringify({ reply: JSON.stringify(candidate()) });
    const saved = JSON.stringify({ outcome: "completed", result });
    writeFileSync(join(folder, "result.json"), saved, { mode: 0o600 });
    const worker = scene.worker("bare", {
      workflowId: () => Promise.resolve("analyze-chats"),
      document: () => {
        throw new Error("replay-must-not-read-evidence");
      },
    });
    const expected = {
      kind: "completed",
      receipt: journalKey(analysis.operationId),
      worker: "claude",
      result,
    };
    assert.deepEqual(await worker.reconcile(analysis, signal), expected);
    assert.deepEqual(readdirSync(folder), ["result.json"]);
    assert.equal(readFileSync(join(folder, "result.json"), "utf8"), saved);
    assert.deepEqual(await worker.reconcile(analysis, signal), expected);
    assert.deepEqual(await worker.deliver(analysis, signal), expected);
    assert.deepEqual(await worker.stop(analysis, signal), expected);
    assert.deepEqual(scene.turns(), []);
    assert.deepEqual(scene.reports, []);
  }));

await test("CLV-116 fixed Claude analysis removes tools and customization, keeps evidence private, and bypasses git with a Codex development worker", () =>
  withScene(async (scene) => {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "synthetic-api-key";
    const reply = JSON.stringify(candidate());
    const restore = installAnalysisCli(scene, { reply });
    try {
      const worker = scene.worker("complete", {
        worker: "codex",
        tokenPrices: { sonnet: { input: 2, cachedInput: 0.5, output: 8 } },
        workflowId: () => Promise.resolve("analyze-chats"),
        document: () => Promise.resolve(JSON.stringify({ snapshot })),
      });
      assert.deepEqual(await worker.deliver(analysis, signal), {
        receipt: journalKey(analysis.operationId),
        worker: "claude",
      });
      await until(() => scene.reports.length === 1);
      const turn = scene.turns()[0];
      assert.ok(turn);
      assert.deepEqual(turn.files, []);
      assert.equal(existsSync(scene.worktrees), false);
      checkLaunch(turn);
      const result = resultOf(scene.reports[0]?.result);
      assert.equal(result["reply"], reply);
      assert.equal(result["summary"], undefined);
      assert.equal(result["costUsd"], 0.25);
      assert.equal(result["model"], "sonnet");
      assert.ok(Math.abs(Number(result["estimatedCostUsd"]) - 0.0046) < 1e-15);
      assert.notEqual(result["usage"], undefined);
      const folder = join(scene.journal, journalKey(analysis.operationId));
      assert.equal(statSync(folder).mode & 0o777, 0o700);
      assert.equal(statSync(join(folder, "result.json")).mode & 0o777, 0o600);
      assert.equal(
        readdirSync(folder).some(
          (name) => name === "turn.jsonl" || name === "turn.stderr.log",
        ),
        false,
      );
      assert.deepEqual(
        await scene
          .worker("bare", {
            workflowId: () => Promise.resolve("analyze-chats"),
          })
          .reconcile(analysis, signal),
        {
          kind: "completed",
          receipt: journalKey(analysis.operationId),
          worker: "claude",
          result: scene.reports[0]?.result,
        },
      );
      assert.equal(scene.turns().length, 1);
    } finally {
      restore();
      if (apiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = apiKey;
    }
  }));

await test("CLV-116 analysis rejects profile overrides and other workflow IDs before a launch", () =>
  withScene(async (scene) => {
    for (const settings of [
      { workflowId: () => Promise.resolve("develop-ticket") },
      {
        workflowId: () => Promise.resolve("analyze-chats"),
        profiles: { "analyze-chats": { allowedTools: ["Bash"] } },
      },
    ]) {
      const outcome = await scene
        .worker("bare", settings)
        .deliver(analysis, signal);
      assert.deepEqual(outcome, {
        kind: "failed",
        reason: "analysis-worker-unavailable",
      });
    }
    assert.equal(scene.turns().length, 0);
    assert.equal(existsSync(scene.worktrees), false);
  }));

function checkLaunch(turn: TurnRecord): void {
  const flags = turn.arguments;
  assert.deepEqual(
    {
      bare: flags.includes("--bare"),
      token: turn.environment["CLAUDE_CODE_OAUTH_TOKEN"],
      apiKey: turn.environment["ANTHROPIC_API_KEY"],
    },
    { bare: false, token: "synthetic-subscription-token", apiKey: undefined },
  );
  assert.equal(flags[flags.indexOf("--max-turns") + 1], "1");
  assert.equal(flags[flags.indexOf("--max-budget-usd") + 1], "5");
  assert.equal(
    turn.environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
    "1",
  );
  assert.equal(turn.environment["HOME"], turn.environment["CLAUDE_CONFIG_DIR"]);
  assert.equal(
    turn.environment["TMPDIR"],
    turn.environment["CLAUDE_CONFIG_DIR"],
  );
  assert.notEqual(turn.environment["HOME"], turn.directory);
  for (const flag of [
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
  ])
    assert.ok(flags.includes(flag), flag);
  assert.equal(flags[flags.indexOf("--tools") + 1], "");
  assert.equal(flags[flags.indexOf("--disallowedTools") + 1], "mcp__*");
  assert.deepEqual(
    JSON.parse(String(flags[flags.indexOf("--mcp-config") + 1])),
    { mcpServers: {} },
  );
  assert.equal(flags[flags.indexOf("--setting-sources") + 1], "");
  assert.equal(
    resultOf(String(flags[flags.indexOf("--settings") + 1]))["disableAllHooks"],
    true,
  );
  const instruction = flags[flags.indexOf("--system-prompt") + 1] ?? "";
  assert.match(instruction, /inert evidence/);
  assert.match(instruction, /counterevidenceRefs/);
  assert.equal(instruction.includes(corpus), false);
}
