import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { intent, resultOf, until, withScene } from "./claude-worker-fixture.ts";

await test("CLV-123 the worker preserves ticket status and remaining items before both summary limits", () =>
  withScene(async (scene) => {
    const statuses = [
      { kind: "complete" },
      { kind: "partial", remaining: ["Add recovery.", "Verify restart."] },
    ];
    for (const [index, status] of statuses.entries()) {
      const suffix =
        status.kind === "complete"
          ? "Ticket status: complete"
          : "Remaining:\n- Add recovery.\n- Verify restart.\nTicket status: partial";
      writeFileSync(
        join(scene.directory, "turns.log.reply"),
        `${"語".repeat(40_000)}\n${suffix}`,
      );
      const operationId = `operation-${String(index)}`;
      const worker = scene.worker("fixed-reply");
      await worker.deliver(
        intent({ operationId }),
        new AbortController().signal,
      );
      await until(() => scene.reports.length === index + 1);
      const report = scene.reports[index];
      const result = resultOf(report?.result);
      assert.deepEqual(result["ticketStatus"], status);
      assert.ok(String(result["summary"]).length < 16_000);
      assert.ok(Buffer.byteLength(String(report?.result)) <= 48_000);
      assert.equal(String(result["summary"]).includes("Ticket status:"), false);
      assert.deepEqual(
        await scene
          .worker("hold")
          .reconcile(intent({ operationId }), new AbortController().signal),
        {
          kind: "completed",
          receipt: report?.commandId.slice("claude-turn:".length),
          worker: "claude",
          result: report?.result,
        },
      );
    }
  }));

await test("CLV-123 oversized remaining fields fail visibly with bounded cost data instead of an oversized result", () =>
  withScene(async (scene) => {
    writeFileSync(
      join(scene.directory, "turns.log.reply"),
      `Remaining:\n- ${"x".repeat(300_000)}\nTicket status: partial`,
    );
    await scene
      .worker("fixed-reply")
      .deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.equal(report?.outcome, "failed");
    assert.equal(report.reason, "claude-result-too-large");
    assert.ok(Buffer.byteLength(String(report.result)) <= 48_000);
    assert.equal(resultOf(report.result)["costUsd"], 0.25);
    assert.equal(resultOf(report.result)["ticketStatus"], undefined);
  }));
