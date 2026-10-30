import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export async function withLockOwner(
  scene: Scene,
  scenario: {
    readonly processId: number;
    readonly directory: string;
    readonly lockPath: string;
    readonly run: () => Promise<void>;
  },
): Promise<void> {
  const proc = join(scene.directory, "owner-proc");
  const entry = join(proc, String(scenario.processId));
  mkdirSync(join(entry, "fd"), { recursive: true });
  mkdirSync(join(entry, "fdinfo"));
  symlinkSync(scenario.directory, join(entry, "cwd"));
  symlinkSync(scenario.lockPath, join(entry, "fd", "3"));
  const { ino } = await filesystem.stat(scenario.lockPath);
  writeFileSync(
    join(entry, "fdinfo", "3"),
    `flags:\t0100001\nino:\t${String(ino)}\n`,
  );
  await withProcFiles(proc, scenario.run);
}

export async function withLockScan(
  scene: Scene,
  scan: {
    readonly run: () => Promise<void>;
    readonly stdout: string;
    readonly stderr?: string;
    readonly code?: number;
  },
): Promise<void> {
  const directory = join(scene.directory, "lock-bin");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "lsof"),
    `#!${process.execPath}
process.stdout.write(${JSON.stringify(scan.stdout)});
process.stderr.write(${JSON.stringify(scan.stderr ?? "")});
process.exitCode = ${String(scan.code ?? 0)};
`,
    { mode: 0o755 },
  );
  const original = process.env["PATH"];
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  process.env["PATH"] = directory + ":" + (original ?? "");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    await scan.run();
  } finally {
    if (original === undefined) delete process.env["PATH"];
    else process.env["PATH"] = original;
    if (platform !== undefined)
      Object.defineProperty(process, "platform", platform);
  }
}

export async function withProcessTable(
  scene: Scene,
  scenario: {
    readonly rows: readonly (string | null)[];
    readonly run: () => Promise<void>;
  },
): Promise<void> {
  const directory = join(scene.directory, "bin");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "ps"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = __filename + ".count";
const count = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : 0;
fs.writeFileSync(path, String(count + 1));
const rows = ${JSON.stringify(scenario.rows)};
const row = rows[Math.min(count, rows.length - 1)];
if (row === null) process.exit(1);
process.stdout.write(row + "\\n");
`,
    { mode: 0o755 },
  );
  const original = process.env["PATH"];
  process.env["PATH"] = directory + ":" + (original ?? "");
  try {
    await scenario.run();
  } finally {
    if (original === undefined) delete process.env["PATH"];
    else process.env["PATH"] = original;
  }
}

export async function withProcFiles(
  directory: string,
  run: () => Promise<void>,
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const list = filesystem.readdir;
  const link = filesystem.readlink;
  const inspect = filesystem.stat;
  const read = filesystem.readFile;
  const mapped = (path: Parameters<typeof link>[0]) =>
    typeof path === "string" && path.startsWith("/proc")
      ? directory + path.slice(5)
      : path;
  mock.method(filesystem, "readdir", (...parts: Parameters<typeof list>) =>
    list(mapped(parts[0]), parts[1]),
  );
  mock.method(filesystem, "readlink", (...parts: Parameters<typeof link>) =>
    link(mapped(parts[0]), parts[1]),
  );
  mock.method(filesystem, "stat", (...parts: Parameters<typeof inspect>) =>
    inspect(mapped(parts[0]), parts[1]),
  );
  mock.method(filesystem, "readFile", (...parts: Parameters<typeof read>) =>
    read(typeof parts[0] === "string" ? mapped(parts[0]) : parts[0], parts[1]),
  );
  Object.defineProperty(process, "platform", { value: "linux" });
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (platform !== undefined)
      Object.defineProperty(process, "platform", platform);
  }
}

export async function withCrashCoverage(
  scene: Scene,
  run: () => Promise<void>,
): Promise<void> {
  const original = process.env["NODE_V8_COVERAGE"];
  process.env["NODE_V8_COVERAGE"] = join(scene.directory, "synthetic-coverage");
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env["NODE_V8_COVERAGE"];
    else process.env["NODE_V8_COVERAGE"] = original;
  }
}
