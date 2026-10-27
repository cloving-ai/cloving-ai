import assert from "node:assert/strict";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  field,
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
