import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import {
  installAnalysisCli,
  intent,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const analysis = intent({ method: "run-turn:analyze-chats", target: importId });
const settings = {
  tokenPrices: { sonnet: { input: 2, cachedInput: 0.5, output: 8 } },
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

await test("CLV-116 stopping and closing active analysis turns leave fixed failures and no replacement", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, {
      reply: "unused",
      mode: "hold",
    });
    try {
      const worker = scene.worker("bare", settings);
      await worker.deliver(analysis, signal);
      await until(() => scene.turns().length === 1);
      const stopped = await worker.stop(analysis, signal);
      assert.equal(stopped.kind, "failed");
      assert.equal(
        "reason" in stopped ? stopped.reason : null,
        "analysis-turn-failed",
      );
      const another = { ...analysis, operationId: "another" };
      await worker.deliver(another, signal);
      await until(() => scene.turns().length === 2);
      await worker.close();
      assert.equal(scene.reports.length, 2);
      assert.deepEqual(await worker.deliver(another, signal), {
        kind: "failed",
        reason: "analysis-turn-failed",
      });
      assert.equal(scene.turns().length, 2);
    } finally {
      restore();
    }
  }));

await test("CLV-116 an aborted delivery starts no turn", () =>
  withScene(async (scene) => {
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(
      await scene.worker("bare", settings).deliver(analysis, aborted.signal),
      { kind: "failed", reason: "analysis-turn-failed" },
    );
    assert.equal(scene.turns().length, 0);
  }));

await test("CLV-116 complete UTF-8 replies at 16000 bytes survive; 16001 bytes block without truncation and retain usage", () =>
  withScene(async (scene) => {
    for (const [index, reply] of [
      "語".repeat(5333) + "x",
      "語".repeat(5333) + "xy",
    ].entries()) {
      const restore = installAnalysisCli(scene, { reply });
      try {
        const worker = scene.worker("bare", settings);
        await worker.deliver(
          { ...analysis, operationId: "boundary-" + String(index) },
          signal,
        );
        await until(() => scene.reports.length === index + 1);
        const report = scene.reports[index];
        const fields = resultOf(report?.result);
        assert.equal(report?.outcome, index === 0 ? "completed" : "failed");
        assert.equal(
          report.reason,
          index === 0 ? undefined : "analysis-reply-too-large",
        );
        assert.equal(fields["reply"], index === 0 ? reply : undefined);
        assert.equal(fields["costUsd"], 0.25);
        assert.ok(
          Math.abs(Number(fields["estimatedCostUsd"]) - 0.0046) < 1e-15,
        );
        assert.deepEqual(fields["usage"], {
          input_tokens: 1500,
          cache_read_input_tokens: 800,
          output_tokens: 150,
        });
      } finally {
        restore();
      }
    }
  }));

for (const mode of ["error-result", "exit-code", "no-result"]) {
  await test(
    "CLV-116 failed analysis blocks with fixed code and available usage: " +
      mode,
    () =>
      withScene(async (scene) => {
        const restore = installAnalysisCli(scene, { reply: "unused", mode });
        try {
          await scene.worker("bare", settings).deliver(analysis, signal);
          await until(() => scene.reports.length === 1);
          assert.equal(scene.reports[0]?.outcome, "failed");
          assert.equal(scene.reports[0].reason, "analysis-turn-failed");
          assert.equal(
            scene.reports[0].result === undefined
              ? null
              : resultOf(scene.reports[0].result)["costUsd"],
            mode === "no-result" ? null : 0.25,
          );
          assert.equal(scene.turns().length, 1);
        } finally {
          restore();
        }
      }),
  );
}

await test("CLV-116 unsupported and absent Claude CLI block before a turn", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, {
      reply: "unused",
      version: "2.1.1 (Claude Code)",
    });
    try {
      assert.deepEqual(
        await scene.worker("bare", settings).deliver(analysis, signal),
        { kind: "failed", reason: "analysis-worker-unavailable" },
      );
    } finally {
      restore();
    }
    const previous = process.env["PATH"];
    process.env["PATH"] = "/usr/bin:/bin";
    try {
      assert.deepEqual(
        await scene.worker("bare", settings).deliver(analysis, signal),
        { kind: "failed", reason: "analysis-worker-unavailable" },
      );
    } finally {
      process.env["PATH"] = previous;
    }
    assert.equal(scene.turns().length, 0);
  }));

await test("CLV-116 interrupted completion is never replaced; live unknown completion remains unknown", () =>
  withScene(async (scene) => {
    const folder = join(scene.journal, journalKey(analysis.operationId));
    mkdirSync(folder, { recursive: true });
    const write = (processId: number | null) => {
      writeFileSync(
        join(folder, "started.json"),
        JSON.stringify({ processId }),
      );
    };
    write(process.pid);
    const worker = scene.worker("bare", settings);
    const unknown = await worker.deliver(analysis, signal);
    assert.ok("kind" in unknown);
    assert.equal(unknown.kind, "unknown");
    write(null);
    const refused = await worker.deliver(analysis, signal);
    assert.ok("kind" in refused);
    assert.equal(refused.kind, "failed");
    assert.equal(
      "reason" in refused ? refused.reason : null,
      "analysis-turn-failed",
    );
    assert.deepEqual(await worker.deliver(analysis, signal), refused);
    assert.equal(scene.turns().length, 0);
    assert.equal(existsSync(scene.worktrees), false);
  }));
