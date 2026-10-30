import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

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
