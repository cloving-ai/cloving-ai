import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";

const guard = resolve("test/self-host-guard.ts");

function alive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function ended(processId: number): Promise<boolean> {
  const deadline = Date.now() + testMilliseconds(5000);
  while (Date.now() < deadline && alive(processId)) await delay(50);
  return !alive(processId);
}

async function written(file: string): Promise<string> {
  const deadline = Date.now() + testMilliseconds(10000);
  while (Date.now() < deadline && !existsSync(file)) await delay(50);
  return await readFile(file, "utf8");
}

function guarded(marker: string, exitCode: number): string {
  return `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on("SIGTERM", () => process.exit(${String(exitCode)})); setInterval(() => {}, 1000);`;
}

await test("CLV-231 the guarded daemon stops when the test process ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-guard-parent-"));
  const marker = join(root, "daemon");
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(guard)}, process.execPath, "-e", ${JSON.stringify(guarded(marker, 0))}], { stdio: "ignore", detached: true }); setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore" },
  );
  let daemon = 0;
  try {
    daemon = Number(await written(marker));
    parent.kill("SIGKILL");
    assert.equal(await ended(daemon), true);
  } finally {
    parent.kill("SIGKILL");
    if (daemon > 0 && alive(daemon)) process.kill(daemon, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-231 the guard passes SIGTERM to the daemon and ends with its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-guard-signal-"));
  const marker = join(root, "daemon");
  const child = spawn(
    process.execPath,
    [guard, process.execPath, "-e", guarded(marker, 75)],
    { stdio: "ignore" },
  );
  const closed = new Promise<number | null>((settle) => {
    child.once("close", settle);
  });
  try {
    const daemon = Number(await written(marker));
    child.kill("SIGTERM");
    assert.equal(await closed, 75);
    assert.equal(await ended(daemon), true);
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
