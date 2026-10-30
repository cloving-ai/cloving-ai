import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fileSystem, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";

const guard = resolve("test/self-host-guard.ts");

function alive(processId: number, marker: string): boolean {
  try {
    process.kill(processId, 0);
  } catch {
    return false;
  }
  const inspected = spawnSync(
    "ps",
    ["-ww", "-p", String(processId), "-o", "command="],
    { encoding: "utf8", timeout: testMilliseconds(5000) },
  );
  if (inspected.error) throw inspected.error;
  if (
    inspected.signal !== null ||
    (inspected.status !== 0 && inspected.status !== 1)
  )
    throw new Error("guard-process-inspection-failed");
  return inspected.status === 0 && inspected.stdout.includes(marker);
}

async function ended(
  processId: number,
  inspection: { readonly marker: string; readonly milliseconds?: number },
): Promise<boolean> {
  const { marker } = inspection;
  const deadline =
    Date.now() + testMilliseconds(inspection.milliseconds ?? 5000);
  while (Date.now() < deadline && alive(processId, marker)) await delay(50);
  return !alive(processId, marker);
}

async function written(file: string): Promise<string> {
  const deadline = Date.now() + testMilliseconds(10000);
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = await readFile(file, "utf8");
      if (text !== "") return text;
    }
    await delay(50);
  }
  throw new Error("guard-marker-not-ready");
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

function stopIfAlive(processId: number, marker: string): void {
  if (processId > 0 && alive(processId, marker))
    process.kill(processId, "SIGKILL");
}

await test("CLV-231 a reused PID does not identify a guarded daemon", () => {
  assert.equal(alive(process.pid, "unrelated-guard-marker"), false);
});

await test("CLV-231 rejects a failed process inspection", () => {
  const descriptor = Object.getOwnPropertyDescriptor(childProcess, "spawnSync");
  assert.ok(descriptor);
  Object.defineProperty(childProcess, "spawnSync", {
    configurable: true,
    value: () => ({ error: undefined, signal: null, status: 2, stdout: "" }),
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => alive(process.pid, "guard-marker"), {
      message: "guard-process-inspection-failed",
    });
  } finally {
    Object.defineProperty(childProcess, "spawnSync", descriptor);
    syncBuiltinESMExports();
  }
});

await test("CLV-231 an empty PID marker is not a ready daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-guard-marker-"));
  const marker = join(root, "daemon");
  const descriptor = Object.getOwnPropertyDescriptor(fileSystem, "readFile");
  assert.ok(descriptor);
  const original = fileSystem.readFile;
  const observed = Promise.withResolvers<undefined>();
  await writeFile(marker, "");
  Object.defineProperty(fileSystem, "readFile", {
    configurable: true,
    value: async (file: string, encoding: "utf8") => {
      const text = await original(file, encoding);
      if (file === marker && text === "") observed.resolve(undefined);
      return text;
    },
  });
  syncBuiltinESMExports();
  try {
    const reading = written(marker);
    assert.equal(
      await Promise.race([
        observed.promise,
        delay(testMilliseconds(5000), "unobserved", { ref: false }),
      ]),
      undefined,
    );
    await writeFile(marker, "12345");
    assert.equal(await reading, "12345");
  } finally {
    Object.defineProperty(fileSystem, "readFile", descriptor);
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

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
      assert.equal(await ended(daemon, { marker, milliseconds: 12000 }), true);
    } finally {
      parent.kill("SIGKILL");
      stopIfAlive(daemon, marker);
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
    assert.equal(daemon === 0 || (await ended(daemon, { marker })), true);
  } finally {
    stopIfAlive(daemon, marker);
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
    assert.equal(
      await ended(child, { marker: descendant, milliseconds: 12000 }),
      true,
    );
  } finally {
    parent.kill("SIGKILL");
    stopIfAlive(child, descendant);
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
    assert.equal(alive(daemon, marker), true);
    child.kill("SIGTERM");
    const code = await Promise.race([
      closed,
      delay(testMilliseconds(5000), "no exit", { ref: false }),
    ]);
    assert.equal(code, 75);
    assert.equal(await ended(daemon, { marker }), true);
  } finally {
    child.kill("SIGKILL");
    stopIfAlive(daemon, marker);
    await rm(root, { recursive: true, force: true });
  }
});
