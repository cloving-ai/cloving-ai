#!/usr/bin/env node
import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { main } from "./cli/main.ts";
import { clientCommand, runtimeDirectory } from "./cli/runtime-directory.ts";
import { commandUsage } from "./cli/usage.ts";

const [command, ...options] = process.argv.slice(2);

function started(runtime: string): Promise<number> {
  const program = join(import.meta.dirname, "..", "tools", "self-host.ts");
  const located = [
    "--runtime",
    runtime,
    "--repository",
    process.cwd(),
    "--client",
    clientCommand(process.env),
  ];
  const child = spawn(process.execPath, [program, ...located, ...options], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env["PATH"]].join(delimiter),
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => child.kill(signal));
  return new Promise((settle) => {
    child.once("close", (status) => {
      settle(status === 0 ? 0 : 1);
    });
  });
}

async function start(): Promise<number> {
  if (options.includes("--help")) {
    process.stdout.write(String(commandUsage["start"]));
    return 0;
  }
  const runtime = runtimeDirectory(process.env);
  if (runtime !== undefined) return await started(runtime);
  process.stderr.write(
    "runtime-directory-unknown: Set CLOVING_RUNTIME_DIR to the runtime directory of the service.\n",
  );
  return 1;
}

if (command === "start") process.exitCode = await start();
else await main(process.argv.slice(2));
