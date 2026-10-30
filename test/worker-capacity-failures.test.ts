import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startRetriedTurn } from "../src/daemon/retrying-turn.ts";
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

await test("CLV-127 an attempt end refuses an invalid saved start time", () =>
  withScene(async (scene) => {
    for (const [index, startedAt] of [undefined, null, 42, {}].entries()) {
      const folder = join(scene.journal, `invalid-${String(index)}`);
      const turn = await startRetriedTurn(
        {
          command: [
            process.execPath,
            join(scene.directory, "fake-claude.mjs"),
            "hold",
            join(scene.directory, "turns.log"),
          ],
          directory: scene.repository,
          folder,
          prompt: "private prompt",
        },
        { metadata: {} },
      );
      try {
        await until(() => scene.turns().length === index + 1);
        await until(
          () =>
            typeof field(
              JSON.parse(readFileSync(join(folder, "attempt-1.json"), "utf8")),
              "sessionId",
            ) === "string",
        );
        writeFileSync(
          join(folder, "attempt-1.json"),
          JSON.stringify({ startedAt }),
        );
      } finally {
        turn.stop(0);
      }
      await assert.rejects(turn.ended, {
        message: "attempt-start-time-missing",
      });
    }
  }));

await test("CLV-127 a missing retry result fails once and leaves unknown totals unknown", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-no-result", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "claude-turn-failed");
    assert.equal(scene.turns().length, 2);
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["costUsd"], null);
    assert.equal(result["turns"], null);
    assert.deepEqual(result["usage"], {
      input_tokens: null,
      cache_read_input_tokens: null,
      output_tokens: null,
    });
  }));

await test("CLV-127 an unknown retry usage field does not erase known fields or invent a cost", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-unknown", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["costUsd"], null);
    assert.deepEqual(result["usage"], {
      input_tokens: 1502,
      cache_read_input_tokens: null,
      output_tokens: null,
    });
  }));

await test("CLV-127 a failed attempt journal write stops the launched process before rejecting", () =>
  withScene(async (scene) => {
    const folder = join(scene.journal, journalKey("operation-1"));
    mkdirSync(join(folder, "attempt-1.json"), { recursive: true });
    const worker = scene.worker("hold");
    await assert.rejects(worker.deliver(intent(), signal));
    const processId = field(
      record(scene, "operation-1/started.json"),
      "processId",
    );
    assert.equal(typeof processId, "number");
    assert.equal(alive(Number(processId)), false);
    assert.equal((await worker.reconcile(intent(), signal)).kind, "failed");
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-127 a failed retry clock leaves the operation for recovery without relaunching", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-always", {
      retryDelay: () => Promise.reject(new Error("clock-failed")),
    });
    await worker.deliver(intent(), signal);
    await until(
      async () => (await worker.reconcile(intent(), signal)).kind === "failed",
    );
    assert.equal(
      field(record(scene, "operation-1/started.json"), "phase"),
      "waiting",
    );
    await worker.close();
    const recovered = await worker.reconcile(intent(), signal);
    assert.equal(recovered.kind, "failed");
    assert.equal(field(recovered, "reason"), "claude-turn-interrupted");
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-127 close waits for a pending launch journal and stops its child", () =>
  withScene(async (scene) => {
    const held = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const rename = filesystem.rename;
    const attempt = join(
      scene.journal,
      journalKey("operation-1"),
      "attempt-1.json",
    );
    filesystem.rename = async (source, destination) => {
      if (destination === attempt) {
        held.resolve(undefined);
        await release.promise;
      }
      await rename(source, destination);
    };
    syncBuiltinESMExports();
    const worker = scene.worker("hold");
    const delivering = worker.deliver(intent(), signal);
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await held.promise;
      await until(() => scene.turns().length === 1);
      closing = worker.close().then(() => {
        closed = true;
      });
      await nextTurn();
      assert.equal(closed, false);
    } finally {
      release.resolve(undefined);
      await delivering;
      await closing;
      filesystem.rename = rename;
      syncBuiltinESMExports();
    }
    assert.equal(closed, true);
    assert.equal(
      alive(
        Number(field(record(scene, "operation-1/started.json"), "processId")),
      ),
      false,
    );
    assert.equal(
      field(record(scene, "operation-1/result.json"), "stoppedBy"),
      "daemon-shutdown",
    );
    assert.equal(scene.reports.length, 0);
    assert.deepEqual(
      await worker.deliver(intent({ operationId: "after-close" }), signal),
      { kind: "failed", reason: "claude-start-aborted" },
    );
    assert.equal(scene.turns().length, 1);
  }));
