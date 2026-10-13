import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const key = journalKey("operation-1");
const accepted = { receipt: key, worker: "claude" };

function identity(operationId: string): typeof accepted {
  return { receipt: journalKey(operationId), worker: "claude" };
}

await test("CLV-013 stop ends a turn in work, records and reports the outcome stopped, and a stop with no turn in work gives the reconcile result", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    assert.deepEqual(await worker.stop(intent(), signal), { kind: "absent" });
    await worker.deliver(intent(), signal);
    await until(() => scene.turns().length === 1);
    const [turn] = scene.turns();
    assert.ok(turn);
    const stopped = { kind: "stopped", ...accepted };
    assert.deepEqual(await worker.stop(intent(), signal), stopped);
    assert.deepEqual(
      [
        alive(turn.processId),
        scene.reports.map((report) => [report.outcome, report.commandId]),
        field(record(scene, "operation-1/result.json"), "outcome"),
      ],
      [false, [["stopped", `claude-turn:${key}`]], "stopped"],
    );
    assert.deepEqual(await worker.stop(intent(), signal), stopped);
    assert.deepEqual(await worker.reconcile(intent(), signal), stopped);
    assert.deepEqual(await worker.deliver(intent(), signal), stopped);
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-013 stop ends a process that does not end at the first signal", () =>
  withScene(async (scene) => {
    const worker = scene.worker("ignore-term");
    await worker.deliver(intent(), signal);
    await until(() => scene.turns().length === 1);
    const [turn] = scene.turns();
    assert.ok(turn);
    assert.deepEqual(await worker.stop(intent(), signal), {
      kind: "stopped",
      ...accepted,
    });
    assert.equal(alive(turn.processId), false);
  }));

await test("CLV-013 close stops each turn in work, waits for them and reports each one as stopped", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    const second = intent({ operationId: "operation-2", target: "ticket/two" });
    await worker.deliver(intent(), signal);
    await worker.deliver(second, signal);
    await until(() => scene.turns().length === 2);
    await worker.close();
    assert.deepEqual(
      scene.turns().map((turn) => alive(turn.processId)),
      [false, false],
    );
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["stopped", "stopped"],
    );
    assert.deepEqual(await worker.reconcile(second, signal), {
      kind: "stopped",
      ...identity("operation-2"),
    });
    await worker.close();
  }));

await test("CLV-013 the abort signal of deliver stops a start in work: no process starts and no record stays", () =>
  withScene(async (scene) => {
    const stopping = new AbortController();
    const worker = scene.worker("complete", {
      document: (digest) => {
        stopping.abort();
        return Promise.resolve(`prompt of ${digest}`);
      },
    });
    assert.deepEqual(await worker.deliver(intent(), stopping.signal), {
      kind: "failed",
      reason: "claude-start-aborted",
    });
    await delay(50);
    assert.deepEqual([scene.turns(), existsSync(scene.journal)], [[], false]);
    assert.deepEqual(await worker.reconcile(intent(), signal), {
      kind: "absent",
    });
  }));

await test("CLV-013 the worker refuses an empty command and an effect intent with no arguments, and a recorded process of a different user is read as alive", () =>
  withScene(async (scene) => {
    assert.throws(() => scene.worker("complete", { command: [] }), {
      message: "invalid-claude-command",
    });
    const bare = {
      kind: "protected-effect" as const,
      runId: "run-1",
      operationId: "operation-1",
      workflow: "sha256:pin",
      inputDigest: intent().inputDigest,
      purpose: "dispatch" as const,
      capability: "claude",
      method: "run-turn",
    };
    const worker = scene.worker("complete");
    for (const partial of [
      bare,
      { ...bare, target: "ticket/one" },
      { ...bare, target: "ticket/one", payload: "sha256:prompt" },
    ])
      assert.deepEqual(await worker.deliver(partial, signal), {
        kind: "failed",
        reason: "unsupported-effect",
      });
    const folder = join(scene.journal, journalKey("operation-foreign"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "started.json"),
      JSON.stringify({ operationId: "operation-foreign", processId: 1 }),
    );
    assert.deepEqual(
      await worker.reconcile(
        intent({ operationId: "operation-foreign" }),
        signal,
      ),
      {
        kind: "unknown",
        evidence: `claude-turn:${journalKey("operation-foreign")}`,
      },
    );
    assert.deepEqual(scene.turns(), []);
  }));

await test("CLV-013 a result line with no line end is read, a line that is no JSON text is ignored, and a work tree that git cannot read gives empty change lists", () =>
  withScene(async (scene) => {
    const results: Readonly<Record<string, unknown>>[] = [];
    for (const [index, mode] of ["unterminated", "wreck"].entries()) {
      const operationId = `operation-${mode}`;
      await scene.worker(mode).deliver(intent({ operationId }), signal);
      await until(() => scene.reports.length === index + 1);
      results.push(resultOf(scene.reports[index]?.result));
    }
    const [unterminated, wrecked] = results;
    assert.deepEqual(
      [
        unterminated?.["summary"],
        scene.reports.map((report) => report.outcome),
      ],
      ["no line end", ["completed", "completed"]],
    );
    assert.deepEqual(
      ["branch", "commits", "files", "uncommitted"].map(
        (name) => wrecked?.[name],
      ),
      ["cloving/ticket-one", [], [], []],
    );
    const next = intent({ operationId: "operation-after" });
    assert.deepEqual(await scene.worker("complete").deliver(next, signal), {
      kind: "failed",
      reason: "work-tree-not-available",
    });
  }));
