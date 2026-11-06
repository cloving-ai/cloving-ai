import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signal } from "./claude-profiles-fixture.ts";
import {
  alive,
  intent,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import {
  elapsedSeconds,
  stopLeftProcesses,
} from "../src/daemon/worktree-processes.ts";

function leaving(scene: Scene): readonly string[] {
  const script = join(scene.directory, "leaving-worker.mjs");
  const child = join(scene.directory, "left-child.pid");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
for await (const chunk of process.stdin) String(chunk);
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);"], { detached: true, stdio: "ignore" });
child.unref();
writeFileSync(${JSON.stringify(child)}, String(child.pid));
console.log(JSON.stringify({ type: "result", is_error: false, result: "done" }));
`,
  );
  return [process.execPath, script];
}

await test("CLV-310 a turn end stops a child in the work tree that ignores SIGTERM and logs it", () =>
  withScene(async (scene) => {
    const lines: string[] = [];
    const worker = scene.worker("bare", {
      command: leaving(scene),
      log: (line) => {
        lines.push(line);
      },
    });
    await worker.deliver(intent({ method: "run-turn" }), signal);
    await until(() => scene.reports.length === 1);
    const child = Number(
      readFileSync(join(scene.directory, "left-child.pid"), "utf8"),
    );
    try {
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(alive(child), false);
      assert.equal(lines.length, 1, lines.join(""));
      assert.match(
        lines[0] ?? "",
        new RegExp(
          `^turn: stopped process ${String(child)} \\(.*node.*\\) left in the work tree ${scene.worktrees}/ticket-one\\n$`,
        ),
      );
    } finally {
      if (alive(child)) process.kill(child, "SIGKILL");
    }
  }));

await test("CLV-310 the age of a process comes from the elapsed time of ps", () => {
  assert.equal(elapsedSeconds("00:05"), 5);
  assert.equal(elapsedSeconds("01:02:03"), 3723);
  assert.equal(elapsedSeconds("2-01:02:03"), 2 * 86_400 + 3723);
});

await test("CLV-310 a turn end stops only the processes in the work tree that are not older than the turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-left-"));
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);",
    ],
    { cwd: directory, detached: true, stdio: "ignore" },
  );
  child.unref();
  const lines: string[] = [];
  const request = {
    directory,
    signal: new AbortController().signal,
    stopMilliseconds: 100,
    log: (line: string) => {
      lines.push(line);
    },
  };
  try {
    await until(() => alive(child.pid ?? 0));
    await stopLeftProcesses({ ...request, seconds: -1 });
    assert.equal(alive(child.pid ?? 0), true);
    assert.deepEqual(lines, []);
    await stopLeftProcesses({ ...request, seconds: 60 });
    assert.equal(alive(child.pid ?? 0), false);
    assert.equal(lines.length, 1);
  } finally {
    if (alive(child.pid ?? 0)) process.kill(child.pid ?? 0, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("CLV-310 a turn end keeps an older process that shares the work tree and the process group of a young process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-left-"));
  const youngFile = join(directory, "young.pid");
  const older = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
setTimeout(() => {
  const young = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(youngFile)}, String(young.pid));
}, 3000);
setInterval(() => undefined, 1000);`,
    ],
    { cwd: directory, detached: true, stdio: "ignore" },
  );
  older.unref();
  const lines: string[] = [];
  let young = 0;
  try {
    await until(
      () =>
        existsSync(youngFile) && Number(readFileSync(youngFile, "utf8")) > 0,
    );
    young = Number(readFileSync(youngFile, "utf8"));
    await until(() => alive(young));
    await stopLeftProcesses({
      directory,
      signal: new AbortController().signal,
      stopMilliseconds: 100,
      seconds: 1,
      log: (line: string) => {
        lines.push(line);
      },
    });
    assert.equal(alive(young), false);
    assert.equal(alive(older.pid ?? 0), true);
    assert.equal(lines.length, 1, lines.join(""));
    assert.match(
      lines[0] ?? "",
      new RegExp(`stopped process ${String(young)} `),
    );
  } finally {
    for (const processId of [young, older.pid ?? 0])
      if (processId > 0 && alive(processId)) process.kill(processId, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
