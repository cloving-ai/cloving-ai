#!/usr/bin/env node
import { addAbortListener } from "node:events";
import { execFile, spawn } from "node:child_process";
import { delimiter, dirname, extname, join } from "node:path";
import { main } from "./cli/main.ts";
import type {
  WatchCommandOutput,
  WatchCommandRunner,
} from "./cli/watch-pr-command.ts";
import { clientCommand, runtimeDirectory } from "./cli/runtime-directory.ts";
import { commandUsage } from "./cli/usage.ts";

const [command, ...options] = process.argv.slice(2);

const watchCommand: WatchCommandRunner = async (request) => {
  const [command = "", ...argumentsList] = request.command;
  const completed = Promise.withResolvers<WatchCommandOutput>();
  const stderr = { text: "" };
  const execution = execFile(
    command,
    argumentsList,
    {
      cwd: request.directory,
      signal: request.signal,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    },
    (error, stdout) => {
      const code = error === null ? 0 : error.code;
      completed.resolve({
        stdout,
        stderr: stderr.text,
        status: typeof code === "number" ? code : null,
        errorCode: typeof code === "string" ? code : null,
      });
    },
  );
  execution.stderr?.on("data", (chunk: Buffer) => {
    stderr.text += chunk.toString();
  });
  const closed = new Promise<void>((resolve) =>
    execution.once("close", () => {
      resolve();
    }),
  );
  const listener = addAbortListener(request.signal, () => {
    execution.kill("SIGKILL");
  });
  try {
    await closed;
    return await completed.promise;
  } finally {
    listener[Symbol.dispose]();
  }
};

function started(
  runtime: string,
  argumentsList: readonly string[],
): Promise<number> {
  const program = join(
    import.meta.dirname,
    "..",
    "tools",
    `self-host${extname(import.meta.filename)}`,
  );
  const located = [
    "--runtime",
    runtime,
    "--repository",
    process.cwd(),
    "--client",
    clientCommand(process.env),
  ];
  const child = spawn(
    process.execPath,
    [program, ...located, ...argumentsList],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), process.env["PATH"]].join(delimiter),
      },
    },
  );
  let stopping = false;
  const interrupt = (): void => {
    stopping = true;
    child.kill("SIGINT");
  };
  const terminate = (): void => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return new Promise((settle) => {
    child.once("close", (status) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      settle(stopping && status === 75 ? 0 : (status ?? 1));
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
    let status = await started(runtime, options);
    const restarting = options.filter((option) => option !== "--reset-queue");
    while (status === 75) status = await started(runtime, restarting);
    return status === 0 ? 0 : 1;
  }
  process.stderr.write(
    "runtime-directory-unknown: Set CLOVING_RUNTIME_DIR to the runtime directory of the service.\n",
  );
  return 1;
}

if (command === "start") process.exitCode = await start();
else
  await main(process.argv.slice(2), {
    repository: process.env["CLOVING_WATCH_REPOSITORY"],
    githubCommand: process.env["CLOVING_GH_COMMAND"],
    execute: watchCommand,
  });
