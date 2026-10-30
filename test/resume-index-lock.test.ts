import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  ownedIndexLock,
  removeStoppedIndexLock,
} from "../src/daemon/resume-index-lock.ts";
import { withScene } from "./claude-worker-fixture.ts";
import { withProcFiles, withLockScan } from "./worktree-process-fixture.ts";

const owner = 2147483000;

for (const scan of [
  { stdout: `p${String(owner)}\nf3\naw\n`, owners: [owner] },
  { stdout: `p${String(owner)}\nf3\nau\n`, owners: [owner] },
  { stdout: `p${String(owner)}\nf3\nar\n`, owners: undefined },
  { stdout: "pbad\nf3\naw\n", owners: undefined },
  { stdout: `p${String(owner)}\nf3\na \n`, owners: undefined },
  {
    stdout: `p${String(owner)}\nf3\naw\n`,
    stderr: "partial scan",
    owners: undefined,
  },
  { stdout: "", code: 2, owners: undefined },
  { stdout: `p${String(owner)}\nf3\naw\np123\nf4\n`, owners: undefined },
])
  await test(`CLV-240 macOS lock inspection validates ownership: ${JSON.stringify(scan)}`, () =>
    withScene(async (scene) => {
      const path = join(scene.directory, "index.lock");
      writeFileSync(path, "index");
      await withLockScan(scene, {
        ...scan,
        run: async () => {
          assert.deepEqual(
            (await ownedIndexLock(path))?.processIds,
            scan.owners,
          );
          assert.equal(existsSync(path), true);
        },
      });
    }));

for (const scenario of [
  { flags: "0100001", owners: [owner] },
  { flags: "0100002", owners: [owner] },
  { flags: "0100000", owners: undefined },
  { flags: "unreadable", owners: undefined },
  { flags: "reused", owners: undefined },
])
  await test(`CLV-240 Linux lock ownership requires a writable descriptor: ${scenario.flags}`, () =>
    withScene(async (scene) => {
      const { flags } = scenario;
      const path = join(scene.directory, "index.lock");
      writeFileSync(path, "index");
      const proc = join(scene.directory, "proc");
      const entry = join(proc, String(owner));
      mkdirSync(join(entry, "fd"), { recursive: true });
      mkdirSync(join(entry, "fdinfo"));
      mkdirSync(join(proc, "vanished"));
      mkdirSync(join(proc, "123"));
      symlinkSync(path, join(entry, "fd", "3"));
      symlinkSync(join(scene.directory, "gone"), join(entry, "fd", "4"));
      symlinkSync(join(scene.repository, "README.md"), join(entry, "fd", "5"));
      const inode = (await filesystem.stat(path)).ino;
      const information =
        flags === "reused"
          ? `flags:\t0100001\nino:\t${String(inode + 1)}\n`
          : `flags:\t${flags}\nino:\t${String(inode)}\n`;
      writeFileSync(join(entry, "fdinfo", "3"), information);
      await withProcFiles(proc, async () => {
        assert.deepEqual(
          (await ownedIndexLock(path))?.processIds,
          scenario.owners,
        );
        assert.equal(existsSync(path), true);
      });
    }));

for (const scenario of ["permission", "disappeared", "missing"] as const)
  await test(`CLV-240 ${scenario} owner inspection preserves unattributed locks`, () =>
    withScene(async (scene) => {
      const path = join(scene.directory, "index.lock");
      writeFileSync(path, "index");
      const proc = join(scene.directory, "proc");
      mkdirSync(proc);
      await withProcFiles(proc, async () => {
        const failed = () =>
          Promise.reject(
            Object.assign(new Error("unavailable"), {
              code: scenario === "permission" ? "EACCES" : "ENOENT",
            }),
          );
        const replies = [
          () =>
            scenario === "missing"
              ? Promise.reject(new Error("scan failed"))
              : Promise.resolve([String(owner)]),
        ];
        mock.method(filesystem, "readdir", () => (replies.shift() ?? failed)());
        syncBuiltinESMExports();
        assert.equal(await ownedIndexLock(path), undefined);
        assert.equal(existsSync(path), true);
      });
    }));

const noChange = () => undefined;
const failures = [
  { name: "stopped", processId: owner, removed: true, prepare: noChange },
  { name: "alive", processId: process.pid, removed: false, prepare: noChange },
  {
    name: "changed",
    processId: owner,
    removed: false,
    prepare: (path: string) => {
      renameSync(path, path + ".old");
      writeFileSync(path, "replacement");
    },
  },
  {
    name: "aborted",
    processId: owner,
    removed: false,
    prepare: (_path: string, stopping: AbortController) => {
      const inspect = filesystem.lstat;
      mock.method(
        filesystem,
        "lstat",
        async (...parts: Parameters<typeof inspect>) => {
          const result = await inspect(...parts);
          stopping.abort();
          return result;
        },
      );
    },
  },
  {
    name: "permission",
    processId: owner,
    removed: false,
    prepare: () => {
      mock.method(process, "kill", () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      });
    },
  },
  {
    name: "unlink-failed",
    processId: owner,
    removed: false,
    prepare: () => {
      mock.method(filesystem, "unlink", () =>
        Promise.reject(new Error("denied")),
      );
    },
  },
];

for (const scenario of failures)
  await test(`CLV-240 ${scenario.name} lock cleanup handles ownership and file identity`, () =>
    withScene(async (scene) => {
      const path = join(scene.directory, "index.lock");
      writeFileSync(path, "index");
      const identity = await filesystem.lstat(path);
      const lock = {
        path,
        dev: identity.dev,
        ino: identity.ino,
        ctimeMs: identity.ctimeMs,
        mtimeMs: identity.mtimeMs,
        processIds: [scenario.processId],
      };
      const stopping = new AbortController();
      scenario.prepare(path, stopping);
      syncBuiltinESMExports();
      try {
        assert.equal(
          await removeStoppedIndexLock(lock, stopping.signal),
          scenario.removed,
        );
        assert.equal(existsSync(path), !scenario.removed);
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    }));
