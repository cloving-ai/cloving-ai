import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  intent,
  git,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { claudeLimits } from "../src/daemon/claude-worker.ts";
import { turnReport } from "../src/daemon/turn-report.ts";
import { streamResult } from "../src/daemon/claude-turn.ts";

await test("CLV-215 reports without attempts keep unknown pricing and reject metadata that cannot fit", () =>
  withScene(async (scene) => {
    const tree = {
      path: scene.repository,
      branch: "main",
      startCommit: git(scene.repository, ["rev-parse", "HEAD"]),
    };
    const result = streamResult(
      JSON.stringify({ type: "result", result: "Ticket status: complete" }),
    );
    assert.ok(result);
    const start = {
      tree,
      harness: { worker: "mytool", output: "text" as const },
      limits: claudeLimits,
    };
    const report = await turnReport(start, result);
    assert.equal(resultOf(report.text)["estimatedCostUsd"], null);
    assert.equal(resultOf(report.text)["attempts"], undefined);
    assert.deepEqual(
      await turnReport(start, {
        ...result,
        text:
          "Remaining:\n- " + "x".repeat(300000) + "\nTicket status: partial",
      }),
      { reason: "claude-result-too-large" },
    );
    assert.deepEqual(
      await turnReport(
        {
          ...start,
          harness: { worker: "claude" },
          limits: { ...claudeLimits, resultBytes: 1 },
        },
        result,
      ),
      { reason: "claude-result-too-large" },
    );
  }));

await test("CLV-215 generic prompt arguments replace once without sending stdin", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "arguments.mjs");
    writeFileSync(
      script,
      `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const {readdirSync} = await import("node:fs");
console.log(JSON.stringify({input, args: process.argv.slice(2), directory: process.cwd(), configuration: process.env.GH_CONFIG_DIR, configurationFiles: readdirSync(process.env.GH_CONFIG_DIR), tokens: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map((name) => process.env[name] ?? null)}));
`,
    );
    const harness = {
      name: "mytool",
      turn: [process.execPath, script, "{prompt}", "literal {prompt}"],
    };
    const worker = scene.worker("bare", {
      harness,
      document: () => Promise.resolve("literal $(touch nope) {prompt}"),
      profiles: {
        checker: {
          env: {
            GH_TOKEN: "blocked",
            GITHUB_TOKEN: "blocked",
            GH_ENTERPRISE_TOKEN: "blocked",
            GITHUB_ENTERPRISE_TOKEN: "blocked",
          },
        },
      },
    });
    await worker.deliver(
      intent({ method: "run-turn:checker" }),
      new AbortController().signal,
    );
    await until(() => scene.reports.length === 1);
    const observed = resultOf(resultOf(scene.reports[0]?.result)["summary"]);
    assert.equal(observed["input"], "");
    assert.deepEqual(observed["args"], [
      "literal $(touch nope) {prompt}",
      "literal {prompt}",
    ]);
    assert.ok(String(observed["directory"]).startsWith(scene.worktrees));
    const configuration = String(observed["configuration"]);
    assert.ok(configuration.includes("/gh-config-"));
    assert.equal(existsSync(configuration), false);
    assert.deepEqual(observed["configurationFiles"], []);
    assert.deepEqual(observed["tokens"], [null, null, null, null]);
  }));

await test("CLV-215 a heavily escaped generic report retains its end within the byte limit", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "escaped.mjs");
    writeFileSync(
      script,
      'process.stdout.write("\\u0000".repeat(40000) + "end\\nTicket status: complete\\n");',
    );
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: [process.execPath, script] },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const text = scene.reports[0]?.result;
    assert.ok(typeof text === "string");
    assert.ok(
      String(resultOf(text)["summary"]).endsWith(
        "end\nTicket status: complete\n",
      ),
    );
    assert.ok(Buffer.byteLength(text) <= claudeLimits.resultBytes);
  }));

await test("CLV-215 generic turns without a placeholder read the prompt from stdin", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "stdin.mjs");
    writeFileSync(
      script,
      "for await (const chunk of process.stdin) process.stdout.write(chunk);",
    );
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: [process.execPath, script] },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(
      resultOf(scene.reports[0]?.result)["summary"],
      "prompt of sha256:prompt",
    );
  }));

await test("CLV-215 generic reports keep the output tail and full ticket status", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "long.mjs");
    writeFileSync(
      script,
      'process.stdout.write("語".repeat(40000) + "\\nRemaining:\\n- " + "r".repeat(17000) + "\\nTicket status: partial\\n");',
    );
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: [process.execPath, script] },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const text = scene.reports[0]?.result;
    assert.ok(typeof text === "string");
    const result = resultOf(text);
    assert.ok(String(result["summary"]).endsWith("Ticket status: partial\n"));
    assert.deepEqual(result["ticketStatus"], {
      kind: "partial",
      remaining: ["r".repeat(17000)],
    });
    assert.ok(Buffer.byteLength(text) <= claudeLimits.resultBytes);
    assert.ok(
      String(result["summary"]).length <= claudeLimits.summaryCharacters,
    );
  }));

await test("CLV-215 a generic nonzero exit reports the stderr tail", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "failed.mjs");
    writeFileSync(
      script,
      'process.stdout.write("wrong report"); process.stderr.write("e".repeat(40000) + "failure end"); process.exitCode = 7;',
    );
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: [process.execPath, script] },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    const result = resultOf(scene.reports[0].result);
    assert.ok(String(result["summary"]).endsWith("failure end"));
    assert.ok(
      String(result["summary"]).length <= claudeLimits.summaryCharacters,
    );
    assert.equal(result["costUsd"], null);
    assert.deepEqual(result["usage"], {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    });
    assert.equal(
      readFileSync(
        join(scene.journal, journalKey("operation-1"), "turn.stderr.log"),
        "utf8",
      ).endsWith("failure end"),
      true,
    );
  }));

await test("CLV-215 an oversized streamed ticket status fails the generic turn", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "oversized-status.mjs");
    writeFileSync(
      script,
      'process.stdout.write("Remaining:\\n- " + "r".repeat(100000) + "\\nTicket status: partial");',
    );
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: [process.execPath, script] },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "claude-result-too-large");
    assert.equal(scene.reports[0].result, undefined);
  }));

await test("CLV-215 generic profiles reject model options before starting a turn", () =>
  withScene(async (scene) => {
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: ["must-not-run"] },
      profiles: { checker: { model: "unknown" } },
    });
    assert.deepEqual(
      await worker.deliver(
        intent({ method: "run-turn:checker" }),
        new AbortController().signal,
      ),
      { kind: "failed", reason: "profile-model-not-supported" },
    );
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-215 a generic capacity-like error still runs only one attempt", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "capacity.mjs");
    writeFileSync(
      script,
      'process.stderr.write("Selected model is at capacity. Please try a different model."); process.exitCode = 1;',
    );
    const worker = scene.worker("bare", {
      harness: { name: "mytool", turn: [process.execPath, script] },
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    const result = resultOf(scene.reports[0].result);
    assert.ok(Array.isArray(result["attempts"]));
    assert.equal(result["attempts"].length, 1);
  }));

await test("CLV-215 a generic harness receives the prompt argument and returns text", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "generic.mjs");
    writeFileSync(script, "process.stdout.write(process.argv[2]);");
    const harness = {
      name: "mytool",
      turn: [process.execPath, script, "{prompt}"],
    };
    const worker = scene.worker("bare", { harness });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["summary"], "prompt of sha256:prompt");
    assert.equal(result["harness"], "mytool");
  }));

await test("CLV-215 a private command wins before prompt routing and ignores the saved path", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "winner.mjs");
    writeFileSync(
      script,
      'let text = ""; for await (const chunk of process.stdin) text += chunk; process.stdout.write("stdin: " + text);',
    );
    const worker = scene.worker("bare", {
      harness: {
        name: "mytool",
        path: "must-not-run",
        command: [process.execPath, script],
        turn: ["also-must-not-run", "{prompt}"],
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(
      resultOf(scene.reports[0]?.result)["summary"],
      "stdin: prompt of sha256:prompt",
    );
  }));

await test("CLV-215 a generic shell harness runs its login function with literal prompt text", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "shell-text.mjs");
    writeFileSync(script, "process.stdout.write(process.argv[2]);");
    writeFileSync(
      join(scene.directory, ".zshrc"),
      `text_turn() { ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"; }`,
    );
    const worker = scene.worker("bare", {
      shell: "/bin/zsh",
      harness: {
        name: "mytool",
        kind: "shell",
        turn: ["text_turn", "{prompt}"],
      },
      profiles: { checker: { env: { ZDOTDIR: scene.directory } } },
      document: () =>
        Promise.resolve("literal $(touch should-not-exist) 'text'"),
    });
    await worker.deliver(
      intent({ method: "run-turn:checker" }),
      new AbortController().signal,
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(
      resultOf(scene.reports[0].result)["summary"],
      "literal $(touch should-not-exist) 'text'",
    );
  }));
