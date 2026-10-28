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

async function ended(processId: number, milliseconds = 5000): Promise<boolean> {
  const deadline = Date.now() + testMilliseconds(milliseconds);
  while (Date.now() < deadline && alive(processId)) await delay(50);
  return !alive(processId);
}

async function written(file: string): Promise<string> {
  const deadline = Date.now() + testMilliseconds(10000);
  while (Date.now() < deadline && !existsSync(file)) await delay(50);
  return await readFile(file, "utf8");
}

function guarded(marker: string, exitCode: number): string {
  return `process.on("SIGTERM", () => process.exit(${String(exitCode)})); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
}

function stubborn(marker: string): string {
  return `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
}

function withChild(daemon: string, child: string): string {
  return `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }); ${daemon}`;
}

function intermediate(
  source: string,
  options: { readonly exitAtOnce: boolean },
): string {
  const spawned = `require("node:child_process").spawn(process.execPath, [${JSON.stringify(guard)}, String(process.pid), process.execPath, "-e", ${JSON.stringify(source)}], { stdio: "ignore", detached: true });`;
  return options.exitAtOnce
    ? `${spawned} process.exit(0);`
    : `${spawned} setInterval(() => {}, 1000);`;
}

function stopIfAlive(processId: number): void {
  if (processId > 0 && alive(processId)) process.kill(processId, "SIGKILL");
}

for (const [name, source] of [
  ["the guarded daemon stops when the test process ends", guarded],
  ["a daemon that ignores SIGTERM stops when the test process ends", stubborn],
] as const)
  await test(`CLV-231 ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cloving-guard-parent-"));
    const marker = join(root, "daemon");
    const parent = spawn(
      process.execPath,
      ["-e", intermediate(source(marker, 0), { exitAtOnce: false })],
      { stdio: "ignore" },
    );
    let daemon = 0;
    try {
      daemon = Number(await written(marker));
      parent.kill("SIGKILL");
      assert.equal(await ended(daemon, 12000), true);
    } finally {
      parent.kill("SIGKILL");
      stopIfAlive(daemon);
      await rm(root, { recursive: true, force: true });
    }
  });

await test("CLV-231 a test process that ends before the guard starts leaves no daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-guard-early-"));
  const marker = join(root, "daemon");
  const parent = spawn(
    process.execPath,
    ["-e", intermediate(guarded(marker, 0), { exitAtOnce: true })],
    { stdio: "ignore" },
  );
  let daemon = 0;
  try {
    await new Promise((settle) => parent.once("close", settle));
    await delay(testMilliseconds(1500));
    daemon = existsSync(marker) ? Number(await readFile(marker, "utf8")) : 0;
    assert.equal(daemon === 0 || (await ended(daemon)), true);
  } finally {
    stopIfAlive(daemon);
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-231 a descendant that ignores SIGTERM stops with the guarded group", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-guard-group-"));
  const marker = join(root, "daemon");
  const descendant = join(root, "descendant");
  const parent = spawn(
    process.execPath,
    [
      "-e",
      intermediate(withChild(guarded(marker, 0), stubborn(descendant)), {
        exitAtOnce: false,
      }),
    ],
    { stdio: "ignore" },
  );
  let child = 0;
  try {
    await written(marker);
    child = Number(await written(descendant));
    parent.kill("SIGKILL");
    assert.equal(await ended(child, 12000), true);
  } finally {
    parent.kill("SIGKILL");
    stopIfAlive(child);
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-231 the guard passes SIGTERM to the daemon and ends with its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-guard-signal-"));
  const marker = join(root, "daemon");
  const child = spawn(
    process.execPath,
    [guard, String(process.pid), process.execPath, "-e", guarded(marker, 75)],
    { stdio: "ignore" },
  );
  const closed = new Promise<number | null>((settle) => {
    child.once("close", settle);
  });
  let daemon = 0;
  try {
    daemon = Number(await written(marker));
    child.kill("SIGTERM");
    const code = await Promise.race([
      closed,
      delay(testMilliseconds(5000), "no exit", { ref: false }),
    ]);
    assert.equal(code, 75);
    assert.equal(await ended(daemon), true);
  } finally {
    child.kill("SIGKILL");
    stopIfAlive(daemon);
    await rm(root, { recursive: true, force: true });
  }
});
