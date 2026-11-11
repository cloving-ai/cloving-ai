import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  processExists,
  processIdentity,
} from "../src/daemon/process-identity.ts";
import { until } from "./claude-worker-fixture.ts";

const heldPs = [
  "#!/bin/sh",
  'case " $* " in *" -p "*) while kill -0 "$PPID" 2>/dev/null; do sleep 0.1; done ;; esac',
  'PATH="${PATH#*:}" exec ps "$@"',
  "",
].join("\n");

const failedPs = [
  "#!/bin/sh",
  'case " $* " in *" -U "*) exit 1 ;; esac',
  'PATH="${PATH#*:}" exec ps "$@"',
  "",
].join("\n");

export async function withFailedSearches<T>(
  directory: string,
  use: () => Promise<T>,
): Promise<T> {
  const folder = join(directory, "failed-tools");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ps"), failedPs, { mode: 0o700 });
  const path = process.env["PATH"] ?? "";
  process.env["PATH"] = `${folder}:${path}`;
  try {
    return await use();
  } finally {
    process.env["PATH"] = path;
  }
}

export function heldIdentityReads(directory: string): string {
  const folder = join(directory, "held-tools");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ps"), heldPs, { mode: 0o700 });
  return folder;
}

export async function crashedService(start: {
  readonly directory: string;
  readonly source: string;
  readonly arguments: readonly string[];
  readonly started: () => boolean;
}): Promise<void> {
  const tools = heldIdentityReads(start.directory);
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", start.source, ...start.arguments],
    {
      cwd: start.directory,
      env: {
        ...process.env,
        NODE_V8_COVERAGE: undefined,
        PATH: `${tools}:${process.env["PATH"] ?? ""}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const closed = new Promise((settle) => child.once("close", settle));
  try {
    await until(() => start.started() || child.exitCode !== null);
    assert.equal(child.exitCode, null, errors);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}

export function markedProcess(directory: string, marker: string) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => require("node:fs").appendFileSync(process.argv[1], "signal\\n")); setInterval(() => {}, 1000);',
      join(directory, "signalled"),
      marker,
    ],
    { detached: true, stdio: "ignore" },
  );
  const processId = child.pid ?? 0;
  return {
    processId,
    known: async () => (await processIdentity(processId)) !== undefined,
    close: () => {
      if (processExists(processId)) process.kill(-processId, "SIGKILL");
    },
  };
}
