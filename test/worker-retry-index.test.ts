import assert from "node:assert/strict";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, mock } from "node:test";
import {
  field,
  interruptedScene,
  priorProcess,
  git,
  intent,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { networkCommand } from "./network-worker-fixture.ts";

const signal = new AbortController().signal;

for (const kind of ["network", "capacity"])
  await test(`CLV-229 a linked worktree index lock survives a ${kind} retry and reports its reason`, () =>
    withScene(async (scene) => {
      let lockPath = "";
      const worker = scene.worker("unused", {
        command: networkCommand(scene, [kind, "done"]),
        retryDelay: () => {
          const tree = scene.turns()[0]?.directory ?? "";
          lockPath = resolve(
            tree,
            git(tree, ["rev-parse", "--git-path", "index.lock"]),
          );
          assert.ok(!lockPath.startsWith(join(tree, ".git") + "/"));
          writeFileSync(lockPath, "held by a prior git process");
          return Promise.resolve();
        },
      });
      await worker.deliver(intent(), signal);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.reason, "worktree-index-locked");
      assert.equal(scene.turns().length, 1);
      assert.equal(existsSync(lockPath), true);
      const failure = record(scene, "operation-1/retry-failure.json");
      assert.equal(field(failure, "lockPath"), lockPath);
      assert.match(
        String(field(failure, "fix")),
        /Remove.*lock.*no git process uses the work tree/,
      );
      assert.equal(
        field(record(scene, "operation-1/result.json"), "reason"),
        "worktree-index-locked",
      );
    }));

await test("CLV-229 a failed lock lookup reports worktree-index-unknown and starts no retry", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "done"]),
      retryDelay: () => {
        const tree = scene.turns()[0]?.directory ?? "";
        renameSync(join(tree, ".git"), join(tree, ".git-held"));
        return Promise.resolve();
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "worktree-index-unknown");
    assert.equal(scene.turns().length, 1);
    assert.equal(
      field(record(scene, "operation-1/retry-failure.json"), "reason"),
      "worktree-index-unknown",
    );
  }));

await test("CLV-240 a daemon resume removes a stale linked-worktree index lock", () =>
  withScene(async (scene) => {
    const tree = await interruptedScene(scene);
    const lockPath = resolve(
      tree,
      git(tree, ["rev-parse", "--git-path", "index.lock"]),
    );
    writeFileSync(lockPath, "stale");
    assert.equal(
      (await scene.worker("crash-once").reconcile(intent(), signal)).kind,
      "accepted",
    );
    await until(() => scene.reports.length === 1);
    assert.equal(existsSync(lockPath), false);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-240 a process that remains keeps the lock and prevents a resume", () =>
  withScene(async (scene) => {
    const tree = await interruptedScene(scene);
    const prior = await priorProcess(scene, { directory: tree });
    const lockPath = resolve(
      tree,
      git(tree, ["rev-parse", "--git-path", "index.lock"]),
    );
    writeFileSync(lockPath, "held");
    const kill = process.kill.bind(process);
    const signals: (number | NodeJS.Signals | undefined)[] = [];
    mock.method(
      process,
      "kill",
      (processId: number, sent?: number | NodeJS.Signals) => {
        const blocked = Math.abs(processId) === prior.processId && sent !== 0;
        if (blocked) signals.push(sent);
        return blocked || kill(processId, sent);
      },
    );
    try {
      const reply = await scene
        .worker("crash-once", { stopMilliseconds: 10 })
        .reconcile(intent(), signal);
      assert.equal(field(reply, "reason"), "worktree-index-locked");
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(existsSync(lockPath), true);
      assert.equal(scene.turns().length, 1);
    } finally {
      mock.restoreAll();
      await prior.close();
    }
  }));
