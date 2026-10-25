import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { located } from "../src/daemon/operation-journal.ts";
import { claimCommand, commandStarted } from "../src/daemon/command-journal.ts";
import { until } from "./claude-worker-fixture.ts";
import {
  commandIntent,
  signal,
  withCommandScene,
} from "./command-worker-fixture.ts";

await test("CLV-178 completed commands replay after a new worker without executing again, even when the command setting is removed", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'require("node:fs").appendFileSync("calls", "one\\n"); process.stdout.write("stored output\\n");',
    );
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    await worker.close();
    const restarted = scene.worker('throw new Error("must not run")', {
      commands: {},
    });
    const expected = {
      kind: "completed",
      receipt: located(scene.journal, "operation-1").key,
      worker: "command",
      result: "stored output\n",
    };
    assert.deepEqual(
      await restarted.reconcile(commandIntent(), signal),
      expected,
    );
    assert.deepEqual(
      await restarted.deliver(commandIntent(), signal),
      expected,
    );
    assert.equal(readFileSync(join(scene.directory, "calls"), "utf8"), "one\n");
  }));

await test("CLV-178 concurrent deliveries of one operation spawn one command", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'require("node:fs").appendFileSync("calls", "one\\n"); setTimeout(() => process.stdout.write("done"), 100);',
    );
    await Promise.all(
      Array.from({ length: 8 }, () => worker.deliver(commandIntent(), signal)),
    );
    await until(() => scene.reports.length >= 1);
    await worker.close();
    assert.equal(readFileSync(join(scene.directory, "calls"), "utf8"), "one\n");
    assert.equal(scene.reports.length, 1);
  }));

await test("CLV-178 an unfinished started command is interrupted and never spawned by a restarted worker", () =>
  withCommandScene(async (scene) => {
    const folder = located(scene.journal, "operation-1").folder;
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "started.json"),
      JSON.stringify({
        name: "scan",
        runId: "run-1",
        operationId: "operation-1",
        startedAt: new Date().toISOString(),
      }),
    );
    const worker = scene.worker(
      'require("node:fs").writeFileSync("rerun", "unsafe");',
    );
    const expected = {
      kind: "failed",
      reason: "command-interrupted",
      receipt: located(scene.journal, "operation-1").key,
      worker: "command",
    };
    assert.deepEqual(await worker.reconcile(commandIntent(), signal), expected);
    assert.deepEqual(await worker.deliver(commandIntent(), signal), expected);
    assert.deepEqual(
      await scene.worker("").deliver(commandIntent(), signal),
      expected,
    );
    assert.equal(existsSync(join(scene.directory, "rerun")), false);
  }));

await test("CLV-178 a stop before or during command execution cannot start another process", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'require("node:fs").appendFileSync("calls", "one\\n"); setInterval(() => {}, 1000);',
    );
    assert.deepEqual(await worker.stop(commandIntent(), signal), {
      kind: "absent",
    });
    await worker.deliver(commandIntent(), signal);
    const calls = join(scene.directory, "calls");
    await until(
      () => existsSync(calls) && readFileSync(calls, "utf8") === "one\n",
    );
    const stopped = await worker.stop(commandIntent(), signal);
    assert.equal(stopped.kind, "stopped");
    assert.deepEqual(await worker.deliver(commandIntent(), signal), stopped);
    assert.equal(readFileSync(calls, "utf8"), "one\n");
  }));

await test("CLV-178 a caller whose dispatch is already aborted cannot start a command", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker(
      'require("node:fs").writeFileSync("rerun", "unsafe");',
    );
    assert.deepEqual(
      await worker.deliver(commandIntent(), AbortSignal.abort()),
      { kind: "failed", reason: "command-start-aborted" },
    );
    await worker.close();
    assert.equal(existsSync(join(scene.directory, "rerun")), false);
  }));

await test("CLV-178 unknown names and unsupported intents refuse without executing and absent payloads refuse", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker("");
    assert.deepEqual(
      await worker.deliver(commandIntent({ method: "run:unknown" }), signal),
      { kind: "failed", reason: "command-unknown" },
    );
    assert.deepEqual(
      await worker.deliver(commandIntent({ capability: "claude" }), signal),
      { kind: "failed", reason: "unsupported-effect" },
    );
    const unavailable = scene.worker("", {
      document: () => Promise.resolve(undefined),
    });
    assert.deepEqual(await unavailable.deliver(commandIntent(), signal), {
      kind: "failed",
      reason: "payload-not-available",
    });
    assert.deepEqual(await worker.reconcile(commandIntent(), signal), {
      kind: "absent",
    });
  }));

await test("CLV-178 recovery retains a completed command when its first report was lost", () =>
  withCommandScene(async (scene) => {
    const original = scene.worker('process.stdout.write("durable");', {
      report: () => Promise.reject(new Error("lost report")),
    });
    await original.deliver(commandIntent(), signal);
    await until(() =>
      existsSync(
        join(located(scene.journal, "operation-1").folder, "result.json"),
      ),
    );
    await original.close();
    const restarted = scene.worker('throw new Error("must not run")');
    await restarted.recover([
      commandIntent({ capability: "claude" }),
      commandIntent({ operationId: "absent" }),
      commandIntent(),
    ]);
    assert.equal(scene.reports.length, 1);
    assert.equal(scene.reports[0]?.result, "durable");
  }));

await test("CLV-178 a crash between claiming an operation and recording its start cannot run it again", () =>
  withCommandScene(async (scene) => {
    mkdirSync(located(scene.journal, "operation-1").folder, {
      recursive: true,
    });
    const worker = scene.worker('throw new Error("must not run")');
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        worker.reconcile(commandIntent(), signal),
      ),
    );
    assert.ok(
      results.every(
        (result) =>
          result.kind === "failed" && result.reason === "command-interrupted",
      ),
    );
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-178 startup recovery waits for a dispatch that is still opening", () =>
  withCommandScene(async (scene) => {
    const payload = Promise.withResolvers<string>();
    let entered = false;
    let recovered = false;
    const worker = scene.worker(
      'setTimeout(() => process.stdout.write("done"), 100);',
      {
        document: () => {
          entered = true;
          return payload.promise;
        },
      },
    );
    const delivery = worker.deliver(commandIntent(), signal);
    await until(() => entered);
    const recovery = worker.recover([commandIntent()]).then(() => {
      recovered = true;
    });
    try {
      await delay(20);
      assert.equal(recovered, false);
    } finally {
      payload.resolve("{}");
    }
    await Promise.all([delivery, recovery]);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));

await test("CLV-178 journal filesystem errors refuse a claim or recovery instead of treating them as absent", () =>
  withCommandScene(async (scene) => {
    await assert.rejects(claimCommand(join(scene.directory, "x".repeat(256))), {
      code: "ENAMETOOLONG",
    });
    const occupied = join(scene.directory, "occupied");
    writeFileSync(occupied, "preserved");
    await assert.rejects(commandStarted(join(occupied, "child")), {
      code: "ENOTDIR",
    });
    assert.equal(readFileSync(occupied, "utf8"), "preserved");
    assert.equal(await commandStarted(join(scene.directory, "absent")), false);
  }));
