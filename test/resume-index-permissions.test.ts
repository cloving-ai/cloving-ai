import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import { ownedIndexLock } from "../src/daemon/resume-index-lock.ts";
import {
  alive,
  git,
  intent,
  interruptedScene,
  priorProcess,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { withLockOwner } from "./worktree-process-fixture.ts";

const owner = 2147483000;
const user = process.geteuid?.() ?? 0;
const foreign = user === 0 ? 1 : 0;
const users = (values: readonly number[]) => `Uid:\t${values.join("\t")}\n`;
const foreignStatus = users([foreign, foreign, foreign, foreign]);

async function inspectDeniedProcess(
  scene: Scene,
  scenario: {
    readonly status?: string;
    readonly mode?: number;
    readonly lockUser?: number;
    readonly code?: string;
  },
) {
  const path = join(scene.directory, "index.lock");
  writeFileSync(path, "index");
  chmodSync(path, scenario.mode ?? 0o600);
  let found: readonly number[] | undefined;
  await withLockOwner(scene, {
    processId: owner,
    directory: scene.directory,
    lockPath: path,
    run: async () => {
      const unrelated = join(scene.directory, "owner-proc", "1");
      mkdirSync(unrelated);
      if (scenario.status !== undefined)
        writeFileSync(join(unrelated, "status"), scenario.status);
      const list = filesystem.readdir;
      mock.method(filesystem, "readdir", (...parts: Parameters<typeof list>) =>
        parts[0] === "/proc/1/fd"
          ? Promise.reject(
              Object.assign(new Error("denied"), {
                code: scenario.code ?? "EACCES",
              }),
            )
          : list(...parts),
      );
      const inspect = filesystem.lstat;
      mock.method(
        filesystem,
        "lstat",
        async (...parts: Parameters<typeof inspect>) => {
          const identity = await inspect(...parts);
          identity.uid = scenario.lockUser ?? identity.uid;
          return identity;
        },
      );
      syncBuiltinESMExports();
      found = (await ownedIndexLock(path))?.processIds;
      assert.equal(await filesystem.readFile(path, "utf8"), "index");
    },
  });
  return found;
}

for (const code of ["EACCES", "EPERM"])
  await test(`CLV-240 an unrelated Linux process with ${code} does not hide the lock owner`, () =>
    withScene(async (scene) => {
      assert.deepEqual(
        await inspectDeniedProcess(scene, { status: foreignStatus, code }),
        [owner],
      );
    }));

for (const scenario of [
  { name: "same user", status: users([user, user, user, user]) },
  { name: "real user", status: users([user, foreign, foreign, foreign]) },
  { name: "effective user", status: users([foreign, user, foreign, foreign]) },
  { name: "saved user", status: users([foreign, foreign, user, foreign]) },
  { name: "filesystem user", status: users([foreign, foreign, foreign, user]) },
  { name: "missing status" },
  { name: "invalid status", status: "Uid:\tunknown\n" },
  { name: "incomplete status", status: users([foreign, foreign, foreign]) },
  { name: "unsafe user ID", status: users([foreign, foreign, foreign, 1e20]) },
  { name: "group writable lock", status: foreignStatus, mode: 0o620 },
  { name: "other writable lock", status: foreignStatus, mode: 0o602 },
  { name: "foreign owned lock", status: foreignStatus, lockUser: foreign },
  { name: "failed descriptor scan", status: foreignStatus, code: "EIO" },
])
  await test(`CLV-240 ${scenario.name} keeps an unchecked possible writer unknown`, () =>
    withScene(async (scene) => {
      assert.equal(await inspectDeniedProcess(scene, scenario), undefined);
    }));

await test("CLV-240 a readable foreign writer is included even for a private lock", () =>
  withScene(async (scene) => {
    const path = join(scene.directory, "index.lock");
    writeFileSync(path, "index");
    chmodSync(path, 0o600);
    await withLockOwner(scene, {
      processId: owner,
      directory: scene.directory,
      lockPath: path,
      run: async () => {
        writeFileSync(
          join(scene.directory, "owner-proc", String(owner), "status"),
          foreignStatus,
        );
        assert.deepEqual((await ownedIndexLock(path))?.processIds, [owner]);
      },
    });
  }));

await test("CLV-240 Linux resume cleans an owned lock despite unrelated descriptor permission failures", () =>
  withScene(async (scene) => {
    const tree = await interruptedScene(scene);
    const lockPath = resolve(
      tree,
      git(tree, ["rev-parse", "--git-path", "index.lock"]),
    );
    const prior = await priorProcess(scene, { directory: tree, lockPath });
    try {
      assert.ok(typeof prior.processId === "number");
      await withLockOwner(scene, {
        processId: prior.processId,
        directory: tree,
        lockPath,
        run: async () => {
          const unrelated = join(scene.directory, "owner-proc", "1");
          mkdirSync(unrelated);
          writeFileSync(join(unrelated, "status"), foreignStatus);
          const list = filesystem.readdir;
          mock.method(
            filesystem,
            "readdir",
            (...parts: Parameters<typeof list>) =>
              parts[0] === "/proc/1/fd"
                ? Promise.reject(
                    Object.assign(new Error("denied"), { code: "EACCES" }),
                  )
                : list(...parts),
          );
          syncBuiltinESMExports();
          const reply = await scene
            .worker("crash-once")
            .reconcile(intent(), new AbortController().signal);
          assert.equal(reply.kind, "accepted");
          await until(() => scene.reports.length === 1);
          assert.equal(prior.terminated(), true);
          assert.equal(alive(prior.processId ?? 0), false);
          assert.equal(existsSync(lockPath), false);
          assert.equal(scene.reports[0]?.outcome, "completed");
          assert.equal(scene.turns().length, 2);
        },
      });
    } finally {
      await prior.close();
    }
  }));
