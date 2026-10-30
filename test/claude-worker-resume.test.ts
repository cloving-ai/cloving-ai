import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  alive,
  field,
  git,
  intent,
  journalKey,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { networkCommand } from "./network-worker-fixture.ts";

const signal = new AbortController().signal;
const key = journalKey("operation-1");

await test("CLV-239 the session is journaled before a result or process exit", () =>
  withScene(async (scene) => {
    await scene.worker("hold").deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    assert.equal(scene.reports.length, 0);
  }));

await test("CLV-239 a drop on a fresh worker stops suspended work without resuming it", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const reply = await scene.worker("hold").stop(intent(), signal);
    assert.equal(reply.kind, "stopped");
    assert.equal(
      field(record(scene, "operation-1/result.json"), "stoppedBy"),
      undefined,
    );
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["stopped"],
    );
    assert.equal(
      (await scene.worker("hold").reconcile(intent(), signal)).kind,
      "stopped",
    );
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-239 shutdown cannot replace an explicit drop that is still stopping", () =>
  withScene(async (scene) => {
    const worker = scene.worker("ignore-term");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    const dropping = worker.stop(intent(), signal);
    await worker.close();
    assert.equal((await dropping).kind, "stopped");
    assert.equal(
      field(record(scene, "operation-1/result.json"), "stoppedBy"),
      undefined,
    );
    assert.deepEqual(
      scene.reports.map((report) => report.outcome),
      ["stopped"],
    );
  }));

await test("CLV-239 cancelled recovery cannot launch a process through reconcile or deliver", () =>
  withScene(async (scene) => {
    const operation = intent({ method: "run-turn:scoped" });
    const settings = {
      profiles: { scoped: { workflows: ["flow"] } },
      workflowId: () => Promise.resolve("flow"),
    };
    const worker = scene.worker("hold", settings);
    await worker.deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const next = scene.worker("hold", settings);
    assert.deepEqual(await next.reconcile(operation, AbortSignal.abort()), {
      kind: "failed",
      reason: "claude-start-aborted",
    });
    const stopping = new AbortController();
    const cancelled = scene.worker("hold", {
      ...settings,
      workflowId: () => {
        stopping.abort();
        return Promise.resolve("flow");
      },
    });
    assert.deepEqual(await cancelled.deliver(operation, stopping.signal), {
      kind: "failed",
      reason: "claude-start-aborted",
    });
    assert.equal(scene.turns().length, 1);
    assert.equal(
      field(record(scene, "operation-1/result.json"), "stoppedBy"),
      "daemon-shutdown",
    );
  }));

await test("CLV-239 a drop racing recovery waits for and stops the resumed launch", () =>
  withScene(async (scene) => {
    const operation = intent({ method: "run-turn:scoped" });
    const settings = {
      profiles: { scoped: { workflows: ["flow"] } },
      workflowId: () => Promise.resolve("flow"),
    };
    const worker = scene.worker("hold", settings);
    await worker.deliver(operation, signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const ready = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const next = scene.worker("hold", {
      ...settings,
      workflowId: async () => {
        ready.resolve(undefined);
        await release.promise;
        return "flow";
      },
    });
    const reconciling = next.reconcile(operation, signal);
    await ready.promise;
    const dropping = next.stop(operation, signal);
    release.resolve(undefined);
    await reconciling;
    assert.equal((await dropping).kind, "stopped");
    assert.equal(
      alive(
        Number(field(record(scene, "operation-1/started.json"), "processId")),
      ),
      false,
    );
    assert.equal(
      field(record(scene, "operation-1/result.json"), "stoppedBy"),
      undefined,
    );
  }));

await test("CLV-239 resume options precede the command prompt separator", () =>
  withScene(async (scene) => {
    const command = [
      process.execPath,
      join(scene.directory, "fake-claude.mjs"),
      "resume-once",
      join(scene.directory, "turns.log"),
      "--",
      "trailing",
    ];
    const worker = scene.worker("unused", { command });
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionCostUsd") ===
        1.2,
    );
    await worker.close();
    await scene.worker("unused", { command }).reconcile(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(scene.turns()[1]?.arguments.slice(2), [
      "--resume",
      "session-1",
      "--",
      "trailing",
    ]);
  }));

await test("CLV-239 a dead process without a result resumes only with a recorded session", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const folder = join(scene.journal, key);
    rmSync(join(folder, "result.json"));
    const path = join(folder, "attempt-1.json");
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...(typeof saved === "object" && saved !== null ? saved : {}),
        sessionId: undefined,
      }),
    );
    const next = scene.worker("hold");
    assert.equal(
      field(await next.reconcile(intent(), signal), "reason"),
      "claude-turn-interrupted",
    );
    assert.equal(scene.turns().length, 1);
    writeFileSync(path, JSON.stringify(saved));
    rmSync(join(folder, "result.json"));
    assert.deepEqual(await next.reconcile(intent(), signal), {
      kind: "accepted",
      receipt: key,
      worker: "claude",
    });
    await until(() => scene.turns().length === 2);
    assert.ok(scene.turns()[1]?.arguments.includes("--resume"));
  }));

await test("CLV-239 a third interruption cannot start a third resumed attempt", () =>
  withScene(async (scene) => {
    let worker = scene.worker("hold");
    const reasons: unknown[] = [];
    await worker.deliver(intent(), signal);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await until(
        () =>
          typeof field(
            record(scene, `operation-1/attempt-${String(attempt)}.json`),
            "sessionId",
          ) === "string",
      );
      await worker.close();
      worker = scene.worker("hold");
      const reply = await worker.reconcile(intent(), signal);
      assert.equal(reply.kind, attempt < 3 ? "accepted" : "failed");
      reasons.push(field(reply, "reason"));
    }
    assert.equal(scene.turns().length, 3);
    assert.equal(reasons.at(-1), "claude-turn-interrupted");
  }));

await test("CLV-239 concurrent reconciliations start only one resumed process", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const next = scene.worker("hold");
    const replies = await Promise.all([
      next.reconcile(intent(), signal),
      next.reconcile(intent(), signal),
      next.deliver(intent(), signal),
    ]);
    assert.ok(replies.every((reply) => field(reply, "receipt") === key));
    await until(() => scene.turns().length >= 2);
    await next.close();
    assert.equal(scene.turns().length, 2);
    assert.equal(
      field(record(scene, "operation-1/started.json"), "attempt"),
      2,
    );
  }));

await test("CLV-239 resume preserves the original turn time, head and earlier retry kind", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-hold", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-2.json"), "sessionId") ===
        "session-2",
    );
    const first = record(scene, "operation-1/started.json");
    await worker.close();
    await scene.worker("complete").reconcile(intent(), signal);
    await until(() => scene.reports.length === 1);
    const latest = record(scene, "operation-1/started.json");
    for (const name of ["startedAt", "turnStartCommit"])
      assert.equal(field(latest, name), field(first, name));
    const result: unknown = JSON.parse(String(scene.reports[0]?.result));
    const attempts = field(result, "attempts");
    assert.ok(Array.isArray(attempts));
    assert.equal(field(attempts[0], "retryKind"), "capacity");
  }));

await test("CLV-239 shutdown in a capacity or network wait never resumes", async () => {
  for (const kind of ["capacity", "network"])
    await withScene(async (scene) => {
      const operationId = `wait-${kind}`;
      let waiting = false;
      const worker = scene.worker("capacity-always", {
        ...(kind === "network"
          ? { command: networkCommand(scene, ["network", "done"]) }
          : {}),
        retryDelay: (milliseconds, stopping) => {
          waiting = true;
          return delay(milliseconds, undefined, { signal: stopping });
        },
      });
      await worker.deliver(intent({ operationId }), signal);
      await until(() => waiting);
      await worker.close();
      const next = scene.worker("hold");
      const reply = await next.reconcile(intent({ operationId }), signal);
      assert.equal(field(reply, "reason"), "claude-turn-interrupted");
      assert.equal(scene.turns().length, 1);
      assert.deepEqual(scene.reports, []);
    });
});

await test("CLV-239 a worktree index lock refuses a resume without removing the lock", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await until(
      () =>
        field(record(scene, "operation-1/attempt-1.json"), "sessionId") ===
        "session-1",
    );
    await worker.close();
    const directory = scene.turns()[0]?.directory;
    assert.ok(directory);
    const lock = git(directory, ["rev-parse", "--git-path", "index.lock"]);
    writeFileSync(lock, "owned by another process");
    const reply = await scene.worker("hold").reconcile(intent(), signal);
    assert.equal(field(reply, "reason"), "worktree-index-locked");
    assert.equal(readFileSync(lock, "utf8"), "owned by another process");
    assert.equal(scene.turns().length, 1);
  }));
