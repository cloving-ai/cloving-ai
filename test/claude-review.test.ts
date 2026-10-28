import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewReport } from "../src/review-subject.ts";
import { intent, resultOf, until, withScene } from "./claude-worker-fixture.ts";

await test("CLV-220 native turns retain final review verdicts before report limits and reconciliation", () =>
  withScene(async (scene) => {
    const cases = [
      {
        report: "Fix the race.\nReview verdict: change",
        verdict: "change",
        feedback: "Fix the race.",
      },
      {
        report: `${"語".repeat(40_000)}\nReview verdict: accept\n`,
        verdict: "accept",
        feedback: "語",
      },
      { report: "No verdict.", verdict: null, feedback: "No verdict." },
      {
        report: "Review verdict: accept\nMore feedback.",
        verdict: null,
        feedback: "More feedback.",
      },
    ];
    for (const [index, entry] of cases.entries()) {
      writeFileSync(join(scene.directory, "turns.log.reply"), entry.report);
      const request = intent({
        operationId: `review-${String(index)}`,
        method: "run-turn:checker",
      });
      await scene
        .worker("fixed-reply", { profiles: { checker: {} } })
        .deliver(request, new AbortController().signal);
      await until(() => scene.reports.length === index + 1);
      const report = scene.reports[index];
      assert.equal(report?.outcome, "completed");
      const result = resultOf(report.result);
      assert.equal(result["reviewVerdict"], entry.verdict);
      assert.ok(String(result["summary"]).includes(entry.feedback));
      assert.equal(reviewReport(String(result["summary"])).reviewVerdict, null);
      assert.ok(String(result["summary"]).length <= 16_000);
      assert.ok(Buffer.byteLength(String(report.result)) <= 48_000);
      assert.equal(
        (
          await scene
            .worker("hold")
            .reconcile(request, new AbortController().signal)
        ).kind,
        "completed",
      );
    }
  }));

await test("CLV-220 text turns retain a verdict across chunk boundaries and discarded trailing whitespace", () =>
  withScene(async (scene) => {
    const script = join(scene.directory, "review.mjs");
    writeFileSync(
      script,
      `
for await (const chunk of process.stdin) {}
process.stdout.write("語".repeat(60_000) + "\\nReview ver");
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write("dict: change\\r\\n" + "\\n".repeat(60_000));
`,
    );
    const request = intent({ method: "run-turn:checker" });
    await scene
      .worker("bare", {
        worker: "review-tool",
        harness: {
          name: "review-tool",
          turn: [process.execPath, script],
          output: "text",
        },
        profiles: { checker: {} },
      })
      .deliver(request, new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.equal(report?.outcome, "completed");
    const result = resultOf(report.result);
    assert.equal(result["reviewVerdict"], "change");
    assert.ok(/^語+$/.test(String(result["summary"])));
    assert.ok(Buffer.byteLength(String(report.result)) <= 48_000);
  }));
