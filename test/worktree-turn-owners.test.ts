import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  intent,
  interruptedScene,
  priorProcess,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { activeOwners, ownTurn } from "../src/daemon/turn-owners.ts";
import { stopLeftProcesses } from "../src/daemon/worktree-processes.ts";
import { resumeWorktree } from "../src/daemon/resume-worktree.ts";

const signal = new AbortController().signal;

function pidFrom(file: string): number {
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
}

function leavingTurn(directory: string): {
  readonly root: ChildProcess;
  readonly left: () => number;
} {
  const file = join(directory, "left.pid");
  const root = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const left = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
left.unref();
require("node:fs").writeFileSync(${JSON.stringify(file)}, String(left.pid));`,
    ],
    { cwd: directory, stdio: "ignore" },
  );
  return { root, left: () => pidFrom(file) };
}

function activeTurn(directory: string): {
  readonly root: ChildProcess;
  readonly child: () => number;
} {
  const file = join(directory, "child.pid");
  const root = spawn(
    process.execPath,
    [
      "-e",
      `const child = require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(file)}, String(child.pid));
setInterval(() => undefined, 1000);`,
    ],
    { cwd: directory, stdio: "ignore" },
  );
  return { root, child: () => pidFrom(file) };
}

function stopAll(processIds: readonly number[]): void {
  for (const processId of processIds)
    if (processId > 0 && alive(processId)) process.kill(processId, "SIGKILL");
}

await test("CLV-346 when two turns run in one work tree, the end of the first stops its orphan and keeps the process tree of the second", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-two-turns-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  const turnA = leavingTurn(directory);
  const turnB = activeTurn(directory);
  const rootB = turnB.root.pid ?? 0;
  const ended = ownTurn(directory, { runId: "run-b", processId: rootB });
  const lines: string[] = [];
  try {
    await until(() => turnA.left() > 0 && turnB.child() > 0);
    await until(() => turnA.root.exitCode !== null);
    await stopLeftProcesses({
      directory,
      runId: "run-a",
      seconds: 60,
      signal,
      stopMilliseconds: 100,
      log: (line) => {
        lines.push(line);
      },
    });
    assert.equal(alive(turnA.left()), false);
    assert.equal(alive(rootB), true);
    assert.equal(alive(turnB.child()), true);
    assert.ok(
      lines.some((line) =>
        new RegExp(
          `^turn: stopped process ${String(turnA.left())} \\(.+\\) that run run-a left in the work tree `,
        ).test(line),
      ),
      lines.join(""),
    );
    for (const processId of [rootB, turnB.child()])
      assert.ok(
        lines.some((line) =>
          new RegExp(
            `^turn: kept process ${String(processId)} \\(.+\\) of the active run run-b in the work tree `,
          ).test(line),
        ),
        lines.join(""),
      );
  } finally {
    ended();
    stopAll([turnA.left(), turnB.child(), rootB]);
    rmSync(directory, { recursive: true, force: true });
  }
});

function stubbornLeftover(directory: string): {
  readonly process: ChildProcess;
  readonly ready: () => boolean;
  readonly terminated: () => boolean;
} {
  const file = join(directory, "term-seen");
  const readyFile = join(directory, "term-ready");
  const leftover = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(file)}, "seen"));
fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => undefined, 1000);`,
    ],
    { cwd: directory, detached: true, stdio: "ignore" },
  );
  leftover.unref();
  return {
    process: leftover,
    ready: () => existsSync(readyFile),
    terminated: () => existsSync(file),
  };
}

await test("CLV-346 a turn that starts in the work tree during the grace period of a cleanup is kept", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-late-turn-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  const leftover = stubbornLeftover(directory);
  const leftoverId = leftover.process.pid ?? 0;
  const turns: { root: number; child: () => number }[] = [];
  const ended: (() => void)[] = [];
  try {
    await until(() => leftover.ready());
    const cleanup = stopLeftProcesses({
      directory,
      runId: "run-a",
      seconds: 60,
      signal,
      stopMilliseconds: 2000,
      log: () => undefined,
    });
    await until(() => leftover.terminated());
    const turnB = activeTurn(directory);
    const rootB = turnB.root.pid ?? 0;
    turns.push({ root: rootB, child: turnB.child });
    ended.push(ownTurn(directory, { runId: "run-b", processId: rootB }));
    await until(() => turnB.child() > 0);
    await cleanup;
    assert.equal(alive(leftoverId), false);
    assert.equal(alive(rootB), true);
    assert.equal(alive(turnB.child()), true);
  } finally {
    for (const end of ended) end();
    stopAll([
      leftoverId,
      ...turns.flatMap((turn) => [turn.child(), turn.root]),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("CLV-346 the resume cleanup stops the processes of the dead session and keeps the live process tree of another active turn", () =>
  withScene(async (scene) => {
    const directory = await interruptedScene(scene);
    const prior = await priorProcess(scene, { directory });
    const turnB = activeTurn(directory);
    const rootB = turnB.root.pid ?? 0;
    const ended = ownTurn(directory, { runId: "run-b", processId: rootB });
    try {
      await until(() => turnB.child() > 0);
      assert.equal(
        await resumeWorktree({
          directory,
          folder: scene.journal,
          signal,
          stopMilliseconds: 100,
        }),
        null,
      );
      assert.equal(prior.terminated(), true);
      assert.equal(alive(prior.processId ?? 0), false);
      assert.equal(alive(rootB), true);
      assert.equal(alive(turnB.child()), true);
    } finally {
      ended();
      stopAll([turnB.child(), rootB]);
      await prior.close();
    }
  }));

await test("CLV-346 a running turn owns its work tree until its process exits", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    await worker.deliver(intent(), signal);
    await until(() => scene.turns().length === 1);
    const [turn] = scene.turns();
    assert.ok(turn !== undefined);
    await until(async () => (await activeOwners(turn.directory)).length === 1);
    assert.deepEqual(await activeOwners(turn.directory), [
      { runId: "run-1", processId: turn.processId },
    ]);
    await worker.close();
    await until(() => !alive(turn.processId));
    await until(async () => (await activeOwners(turn.directory)).length === 0);
  }));
