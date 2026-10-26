import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  programs,
  stopFixturePrograms,
} from "./self-host-processes-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

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

async function readyProcess(file: string): Promise<number> {
  const deadline = Date.now() + testMilliseconds(10000);
  while (Date.now() < deadline && !existsSync(file)) await delay(50);
  return Number(await readFile(file, "utf8"));
}

await test("CLV-231 the fixture cleanup stops the daemon and watch programs when the git fixture never started", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-fixture-cleanup-"));
  const children = ["daemon", "watch"].map(() =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    }),
  );
  try {
    for (const [index, name] of ["daemon", "watch"].entries())
      await writeFile(
        join(root, `${name}-ready`),
        String(children[index]?.pid ?? 0),
      );
    await stopFixturePrograms(root);
    for (const child of children)
      assert.equal(await ended(child.pid ?? 0), true);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-231 a fixture program stops when its parent process ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-fixture-parent-"));
  const { product } = await programs(root);
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(product, "src/cli.ts"))}], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore" },
  );
  let program = 0;
  try {
    program = await readyProcess(join(root, "watch-ready"));
    assert.ok(alive(program));
    parent.kill("SIGKILL");
    assert.equal(await ended(program), true);
  } finally {
    parent.kill("SIGKILL");
    if (program > 0 && alive(program)) process.kill(program, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-231 a fixture program stops when its parent ends during its startup delay", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-fixture-early-"));
  const { product } = await programs(root, {
    watchStartupMilliseconds: testMilliseconds(1500),
  });
  const started = join(root, "watch-started");
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `require("node:child_process").spawn(process.execPath, [${JSON.stringify(join(product, "src/cli.ts"))}], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore" },
  );
  let program = 0;
  try {
    program = await readyProcess(started);
    parent.kill("SIGKILL");
    assert.equal(existsSync(join(root, "watch-ready")), false);
    assert.equal(await ended(program), true);
  } finally {
    parent.kill("SIGKILL");
    if (program > 0 && alive(program)) process.kill(program, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
