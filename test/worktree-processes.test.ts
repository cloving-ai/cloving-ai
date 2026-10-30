import filesystem from "node:fs/promises";
import timers from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  alive,
  field,
  git,
  intent,
  interruptedScene,
  journalKey,
  priorProcess,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

import {
  withCrashCoverage,
  withProcessTable,
  withProcFiles,
  withLockOwner,
} from "./worktree-process-fixture.ts";
import {
  recordedProcessDirectory,
  stopTreeProcesses,
} from "../src/daemon/worktree-processes.ts";
import { resumeWorktree } from "../src/daemon/resume-worktree.ts";

const signal = new AbortController().signal;

await test("CLV-240 cleanup spaces full scans during the grace period and stops waiting on abort", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const prior = await priorProcess(scene, { directory, ignoreTerm: true });
    const stopping = new AbortController();
    const intervals: number[] = [];
    mock.method(timers, "setTimeout", (milliseconds: number) => {
      intervals.push(milliseconds);
      stopping.abort();
      return Promise.resolve();
    });
    syncBuiltinESMExports();
    try {
      assert.equal(
        await stopTreeProcesses({
          directory,
          folder: scene.journal,
          signal: stopping.signal,
        }),
        false,
      );
      assert.equal(intervals.length, 1);
      assert.ok((intervals[0] ?? 0) >= 200);
      assert.equal(prior.terminated(), true);
      assert.equal(alive(prior.processId ?? 0), true);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await prior.close();
    }
  }));

await test("CLV-240 cleanup resolves a work tree alias before stopping a prior process", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const alias = join(scene.directory, "alias");
    symlinkSync(directory, alias);
    const prior = await priorProcess(scene, { directory });
    const started = record(scene, "operation-1/started.json");
    assert.ok(typeof started === "object" && started !== null);
    writeFileSync(
      join(scene.journal, journalKey("operation-1"), "started.json"),
      JSON.stringify({
        ...started,
        worktree: alias,
        processId: prior.processId,
      }),
    );
    try {
      assert.equal(
        (await scene.worker("crash-once").reconcile(intent(), signal)).kind,
        "accepted",
      );
      assert.equal(prior.terminated(), true);
      assert.equal(alive(prior.processId ?? 0), false);
      await until(() => scene.reports.length === 1);
      assert.deepEqual(
        field(record(scene, "operation-1/resume-processes.json"), "processIds"),
        [prior.processId],
      );
    } finally {
      await prior.close();
    }
  }));

await test("CLV-240 a readable foreign-user process is unsignaled and keeps the lock", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const prior = await priorProcess(scene, { directory });
    const lockPath = git(directory, ["rev-parse", "--git-path", "index.lock"]);
    writeFileSync(lockPath, "held");
    try {
      await withProcessTable(scene, {
        rows: [
          `${String(prior.processId)} ${String(prior.processId)} ${String((process.getuid?.() ?? 0) + 1)}`,
        ],
        run: async () => {
          const result = await resumeWorktree({
            directory,
            folder: scene.journal,
            signal,
            stopMilliseconds: 1,
          });
          assert.equal(result?.reason, "worktree-index-locked");
          assert.equal(prior.terminated(), false);
          assert.equal(alive(prior.processId ?? 0), true);
          assert.equal(existsSync(lockPath), true);
        },
      });
    } finally {
      await prior.close();
    }
  }));

await test("CLV-240 an empty process scan is confirmed before stopping a lock owner and removing its lock", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const lockPath = git(directory, ["rev-parse", "--git-path", "index.lock"]);
    const prior = await priorProcess(scene, { directory, lockPath });
    try {
      assert.ok(typeof prior.processId === "number");
      await withLockOwner(scene, {
        processId: prior.processId,
        directory,
        lockPath,
        run: () =>
          withProcessTable(scene, {
            rows: [
              "",
              `${String(prior.processId)} ${String(prior.processId)} ${String(process.getuid?.())}`,
              "",
            ],
            run: async () => {
              assert.equal(
                await resumeWorktree({
                  directory,
                  folder: scene.journal,
                  signal,
                  stopMilliseconds: 10,
                }),
                null,
              );
              assert.equal(prior.terminated(), true);
              assert.equal(alive(prior.processId ?? 0), false);
              assert.equal(existsSync(lockPath), false);
            },
          }),
      });
    } finally {
      await prior.close();
    }
  }));

await test("CLV-240 a failed process scan preserves a lock and cannot certify a PID", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const lockPath = git(directory, ["rev-parse", "--git-path", "index.lock"]);
    writeFileSync(lockPath, "held");
    await withProcessTable(scene, {
      rows: [null],
      run: async () => {
        assert.equal(await recordedProcessDirectory(process.pid), undefined);
        assert.equal(
          (await resumeWorktree({ directory, folder: scene.journal, signal }))
            ?.reason,
          "worktree-index-locked",
        );
        assert.equal(existsSync(lockPath), true);
      },
    });
    assert.equal(
      await stopTreeProcesses({
        directory: join(scene.directory, "missing"),
        folder: scene.journal,
        signal,
      }),
      false,
    );
  }));

await test("CLV-240 cleanup preserves an inaccessible index lock and an unreadable index path", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const lockPath = git(directory, ["rev-parse", "--git-path", "index.lock"]);
    mkdirSync(lockPath);
    assert.equal(
      (await resumeWorktree({ directory, folder: scene.journal, signal }))
        ?.reason,
      "worktree-index-locked",
    );
    assert.equal(existsSync(lockPath), true);
    assert.equal(
      (
        await resumeWorktree({
          directory: scene.directory,
          folder: scene.journal,
          signal,
        })
      )?.reason,
      "worktree-index-unknown",
    );
  }));

await test("CLV-240 Linux discovery reads proc cwd links and tolerates vanished processes", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const prior = await priorProcess(scene, { directory });
    const proc = join(scene.directory, "proc");
    mkdirSync(join(proc, String(prior.processId)), { recursive: true });
    mkdirSync(join(proc, String(process.pid)));
    symlinkSync(directory, join(proc, String(prior.processId), "cwd"));
    try {
      await withProcFiles(proc, async () => {
        assert.ok(typeof prior.processId === "number");
        assert.equal(
          await recordedProcessDirectory(prior.processId),
          directory,
        );
        assert.equal(await recordedProcessDirectory(process.pid), undefined);
        assert.equal(
          await stopTreeProcesses({
            directory,
            folder: scene.journal,
            signal,
            stopMilliseconds: 50,
          }),
          true,
        );
        assert.equal(prior.terminated(), true);
        assert.equal(alive(prior.processId), false);
      });
    } finally {
      await prior.close();
    }
  }));

for (const group of ["shared", undefined] as const)
  await test(`CLV-240 cleanup uses a safe signal target for a ${group ?? "separate"} process group`, () =>
    withScene(async (scene) => {
      const directory = await interruptedScene(scene);
      const prior = await priorProcess(scene, {
        directory,
        ...(group === undefined ? {} : { group }),
      });
      const signals: number[] = [];
      const kill = process.kill.bind(process);
      mock.method(
        process,
        "kill",
        (processId: number, sent?: number | NodeJS.Signals) => {
          if (sent === "SIGTERM") signals.push(processId);
          return kill(processId, sent);
        },
      );
      try {
        assert.equal(
          await stopTreeProcesses({ directory, folder: scene.journal, signal }),
          true,
        );
        assert.deepEqual(signals, [
          group === "shared" ? prior.processId : -(prior.processId ?? 0),
        ]);
        assert.equal(prior.terminated(), true);
      } finally {
        mock.restoreAll();
        await prior.close();
      }
    }));

await test("CLV-240 cancellation after lock inspection preserves the lock", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const lockPath = git(directory, ["rev-parse", "--git-path", "index.lock"]);
    writeFileSync(lockPath, "held");
    const stopping = new AbortController();
    const inspect = filesystem.lstat;
    mock.method(
      filesystem,
      "lstat",
      async (...parts: Parameters<typeof inspect>) => {
        const stat = await inspect(...parts);
        stopping.abort();
        return stat;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(
        (
          await resumeWorktree({
            directory,
            folder: scene.journal,
            signal: stopping.signal,
          })
        )?.reason,
        "worktree-index-locked",
      );
      assert.equal(existsSync(lockPath), true);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }));

await test("CLV-240 a remaining foreign process blocks resume even without an index lock", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const prior = await priorProcess(scene, { directory });
    try {
      await withProcessTable(scene, {
        rows: [
          `${String(prior.processId)} ${String(prior.processId)} ${String((process.getuid?.() ?? 0) + 1)}`,
        ],
        run: async () => {
          assert.equal(
            (await resumeWorktree({ directory, folder: scene.journal, signal }))
              ?.reason,
            "worktree-index-locked",
          );
          assert.equal(prior.terminated(), false);
        },
      });
    } finally {
      await prior.close();
    }
  }));

await test("CLV-240 the turn crash fixture omits coverage from its disposable child", () =>
  withScene((scene) =>
    withCrashCoverage(scene, async () => {
      await scene.worker("hold").deliver(intent(), signal);
      await until(() => scene.turns().length === 1);
      assert.equal(scene.turns()[0]?.coverage, null);
    }),
  ));

await test("CLV-240 the prior crash fixture omits coverage from its disposable child", () =>
  withScene((scene) =>
    withCrashCoverage(scene, async () => {
      const prior = await priorProcess(scene, { directory: scene.directory });
      try {
        assert.equal(prior.coverage(), null);
      } finally {
        await prior.close();
      }
    }),
  ));
