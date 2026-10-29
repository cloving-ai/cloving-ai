#!/usr/bin/env node
import { createProbeRunner } from "./cli/probe-command.ts";
import { settingsEnvironment } from "./cli/project-settings.ts";
import { addAbortListener } from "node:events";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { main } from "./cli/main.ts";
import { parseInvocation } from "./cli/arguments.ts";
import type {
  WatchCommandOutput,
  WatchCommandRunner,
} from "./cli/watch-pr-command.ts";
import {
  adoptionRecordPath,
  clientCommand,
  legacyRuntimeDirectory,
  runtimeDirectory,
} from "./cli/runtime-directory.ts";
import { commandUsage } from "./cli/usage.ts";

const [command, ...options] = process.argv.slice(2);

function repositoryDirectory(directory: string): string | undefined {
  try {
    return realpathSync(
      execFileSync(
        "git",
        ["-C", resolve(directory), "rev-parse", "--show-toplevel"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim(),
    );
  } catch {
    return undefined;
  }
}

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

interface StartRequest {
  readonly runtime: string;
  readonly argumentsList: readonly string[];
  readonly repository: string | undefined;
}

function startArguments(input: StartRequest): readonly string[] {
  const { runtime, repository, argumentsList } = input;
  const located = [
    "--runtime",
    runtimeDirectory(process.env, repository) ?? runtime,
    "--repository",
    repository ?? process.cwd(),
    "--client",
    clientCommand(process.env, repository),
  ];
  const record =
    repository === undefined
      ? undefined
      : adoptionRecordPath(process.env, repository);
  const legacy = legacyRuntimeDirectory(process.env);
  if (
    !process.env["CLOVING_RUNTIME_DIR"] &&
    record !== undefined &&
    !existsSync(record) &&
    legacy !== undefined
  )
    located.push(
      "--legacy-runtime",
      resolve(legacy),
      "--adoption-record",
      resolve(record),
    );
  return [...located, ...argumentsList];
}

function toolProcess(input: {
  readonly tool: string;
  readonly argumentsList: readonly string[];
}): Promise<number> {
  const program = join(
    import.meta.dirname,
    "..",
    "tools",
    `${input.tool}${extname(import.meta.filename)}`,
  );
  const child = spawn(process.execPath, [program, ...input.argumentsList], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env["PATH"]].join(delimiter),
    },
  });
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

function started(input: StartRequest): Promise<number> {
  return toolProcess({
    tool: "self-host",
    argumentsList: startArguments(input),
  });
}

async function start(): Promise<number> {
  if (options.includes("--help")) {
    process.stdout.write(String(commandUsage["start"]));
    return 0;
  }
  const parsed = parseArgs({
    args: options,
    options: { repository: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const selected = parsed.values["repository"];
  if (
    Object.hasOwn(parsed.values, "repository") &&
    (typeof selected !== "string" || selected === "")
  ) {
    process.stderr.write("missing-value: --repository needs a directory.\n");
    return 1;
  }
  if (parsed.positionals.length > 0) {
    process.stderr.write(
      "unexpected-argument: run cloving start --help for usage.\n",
    );
    return 1;
  }
  const repository = repositoryDirectory(
    typeof selected === "string" ? selected : process.cwd(),
  );
  const runtime = runtimeDirectory(process.env, repository);
  if (runtime === undefined) {
    process.stderr.write(
      "repository-unknown: Change to the service repository, use --repository <directory>, or set CLOVING_RUNTIME_DIR.\n",
    );
    return 1;
  }
  let status = await started({ runtime, argumentsList: options, repository });
  const restarting = options.filter((option) => option !== "--reset-queue");
  while (status === 75)
    status = await started({
      runtime,
      argumentsList: restarting,
      repository,
    });
  return status === 0 ? 0 : 1;
}

if (command === "workflows" && ["list", "test"].includes(options[0] ?? ""))
  process.exitCode = await toolProcess({
    tool: "workflow-command",
    argumentsList: options,
  });
else if (command === "templates")
  process.exitCode = await toolProcess({
    tool: "template-command",
    argumentsList: options,
  });
else if (command === "start") process.exitCode = await start();
else {
  const invocation = parseInvocation(process.argv.slice(2));
  const repository = repositoryDirectory(
    "repository" in invocation
      ? (invocation.repository ?? process.cwd())
      : process.cwd(),
  );
  const settingsRepository =
    process.env["CLOVING_WATCH_REPOSITORY"] ?? repository;
  const environment =
    invocation.kind === "watch" && settingsRepository !== undefined
      ? settingsEnvironment(process.env, settingsRepository)
      : process.env;
  await main(process.argv.slice(2), {
    repository,
    environment,
    doctorProbe: createProbeRunner({
      spawn: (input) => spawn(input.executable, input.arguments, input.options),
      kill: (identifier, signal) => process.kill(identifier, signal),
    }),
    watchPr: {
      repository: process.env["CLOVING_WATCH_REPOSITORY"],
      githubCommand: environment["CLOVING_GH_COMMAND"],
      execute: watchCommand,
    },
  });
}
