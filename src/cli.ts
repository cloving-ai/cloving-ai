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
  const interrupt = (): void => {
    child.kill("SIGINT");
  };
  const terminate = (): void => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return new Promise((settle) => {
    child.once("close", (status) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      settle(status ?? 1);
    });
  });
}

async function start(): Promise<number> {
  if (options.includes("--help")) {
    process.stdout.write(String(commandUsage["start"]));
    return 0;
  }
  const runtime = runtimeDirectory(process.env);
  if (runtime !== undefined) {
    let status = await started(runtime);
    while (status === 75) status = await started(runtime);
    return status === 0 ? 0 : 1;
  }
  process.stderr.write(
    "runtime-directory-unknown: Set CLOVING_RUNTIME_DIR to the runtime directory of the service.\n",
  );
  return 1;
}

if (command === "start") process.exitCode = await start();
else await main(process.argv.slice(2));
