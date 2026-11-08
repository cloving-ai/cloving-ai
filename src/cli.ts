#!/usr/bin/env node
import { createProbeRunner } from "./cli/probe-command.ts";
import { terminateHarness } from "./cli/harness-processes.ts";
import { settingsEnvironment } from "./cli/project-settings.ts";
import { constants as systemConstants, homedir } from "node:os";
import type { HarnessStartRequest } from "./harness-start.ts";
import { addAbortListener } from "node:events";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { main } from "./cli/main.ts";
import { parseInvocation } from "./cli/arguments.ts";
import { repositoryArguments } from "./cli/repository-arguments.ts";
import type {
  WatchCommandOutput,
  WatchCommandRunner,
} from "./cli/watch-pr-command.ts";
import { runtimeDirectory } from "./cli/runtime-directory.ts";
import {
  currentRuntime,
  startArguments,
  startSelection,
  type StartRequest,
} from "./cli/start-arguments.ts";
import { commandUsage } from "./cli/usage.ts";
import { workspaceStart, type WorkspaceHost } from "./cli/workspace-start.ts";
import {
  clearedSettingsNote,
  restartEnvironment,
} from "./cli/start-environment.ts";
import { stalledExit } from "./cli/thread-pool.ts";
import { threadPoolStallExitCode } from "./thread-pool-check.ts";

const [command, ...options] = process.argv.slice(2);
const repositorySelection = repositoryArguments(process.argv.slice(2), {});

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
      maxBuffer: request.outputBytes ?? 1024 * 1024,
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

function spawnedHarness(
  request: HarnessStartRequest,
): ChildProcess | undefined {
  try {
    return spawn(request.executable, request.arguments, {
      cwd: request.directory,
      env: request.environment,
      stdio: "inherit",
    });
  } catch {
    return undefined;
  }
}

function startHarness(request: HarnessStartRequest): Promise<number | null> {
  return new Promise((settle) => {
    const interrupt = (): void => undefined;
    const terminate = (): void => {
      terminateHarness(child?.pid, {
        snapshot: () =>
          execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
            encoding: "utf8",
            timeout: 1000,
          }),
        kill: (identifier, signal) => process.kill(identifier, signal),
      });
    };
    const cleanup = (): void => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const child = spawnedHarness(request);
    if (child === undefined) {
      cleanup();
      settle(null);
      return;
    }
    child.once("error", () => {
      cleanup();
      settle(null);
    });
    child.once("close", (status, signal) => {
      cleanup();
      settle(
        status ?? (signal === null ? 1 : 128 + systemConstants.signals[signal]),
      );
    });
  });
}

type ToolInput = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly argumentsList: readonly string[];
  readonly signal?: AbortSignal | undefined;
} & (
  | { readonly tool: string; readonly executable?: never }
  | { readonly tool?: never; readonly executable: string }
);

function toolArguments(input: ToolInput): string[] {
  if (input.tool === undefined) return [...input.argumentsList];
  const extension = extname(import.meta.filename);
  return [
    join(import.meta.dirname, "..", "tools", `${input.tool}${extension}`),
    ...input.argumentsList,
  ];
}

function toolProcess(input: ToolInput): Promise<number> {
  const argumentsList = toolArguments(input);
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
  const child = spawn(input.executable ?? process.execPath, argumentsList, {
    detached: input.tool === "red-green-command",
    stdio:
      input.tool === "red-green-command"
        ? ["inherit", "inherit", "inherit", "ipc"]
        : "inherit",
    env: {
      ...(input.environment ?? process.env),
      PATH: [dirname(process.execPath), process.env["PATH"]].join(delimiter),
    },
  });
  child.once("error", () => {
    process.stderr.write(
      `tool-unavailable: Install the cloving-zapier integration package (${input.executable ?? input.tool}).\n`,
    );
  });
  const aborted =
    input.signal === undefined
      ? undefined
      : addAbortListener(input.signal, terminate);
  return new Promise((settle) => {
    child.once("close", (status) => {
      aborted?.[Symbol.dispose]();
      setImmediate(() => {
        setImmediate(() => {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", terminate);
          settle(stopping && status === 75 ? 0 : (status ?? 1));
        });
      });
    });
  });
}

function started(
  input: StartRequest & { readonly signal?: AbortSignal | undefined },
): Promise<number> {
  return toolProcess({
    tool: "self-host",
    argumentsList: startArguments(input),
    environment: input.environment,
    signal: input.signal,
  });
}

async function hosted(
  request: Omit<WorkspaceHost, "signal" | "repository"> & {
    readonly repository: string | undefined;
    readonly signal?: AbortSignal;
  },
): Promise<number> {
  const { runtime, repository, options: argumentsList, signal } = request;
  await clearedSettingsNote(dirname(runtime));
  let environment = request.environment;
  let status = await started({
    runtime,
    argumentsList,
    repository,
    environment,
    signal,
  });
  const restarting = argumentsList.filter(
    (option) => option !== "--reset-queue",
  );
  while (status === 75 && signal?.aborted !== true) {
    environment = await restartEnvironment(
      dirname(currentRuntime({ repository, runtime })),
      environment,
    );
    status = await started({
      runtime,
      argumentsList: restarting,
      repository,
      environment,
      signal,
    });
  }
  return status;
}

async function start(): Promise<number> {
  const selection = startSelection(options);
  if (selection.kind === "usage") {
    process.stdout.write(String(commandUsage["start"]));
    return 0;
  }
  if (selection.kind === "refused") {
    process.stderr.write(selection.text);
    return 1;
  }
  if (selection.kind === "workspace")
    return workspaceStart({
      options: selection.options,
      environment: process.env,
      home: homedir(),
      repositoryDirectory,
      hosted,
      print: (text) => process.stdout.write(text),
      refuse: (text) => process.stderr.write(text),
    });
  const repository = repositoryDirectory(selection.directory ?? process.cwd());
  const runtime = runtimeDirectory(process.env, repository);
  if (runtime === undefined) {
    process.stderr.write(
      "repository-unknown: Change to the service repository, use --repository <directory>, or set CLOVING_RUNTIME_DIR.\n",
    );
    return 1;
  }
  const status = await hosted({
    runtime,
    repository,
    options,
    environment: process.env,
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
else if (command === "red-green")
  process.exitCode = await toolProcess({
    tool: "red-green-command",
    argumentsList: options,
  });
else if (command === "start") process.exitCode = await start();
else if (
  typeof repositorySelection !== "string" &&
  (repositorySelection.argumentsList[0] === "integrations" ||
    (repositorySelection.argumentsList[0] === "mcp" &&
      repositorySelection.argumentsList.some((option) =>
        /^--connection(?:=|$)/.test(option),
      )))
) {
  const repository = repositoryDirectory(
    repositorySelection.repository ?? process.cwd(),
  );
  const runtime = runtimeDirectory(process.env, repository);
  process.exitCode = await toolProcess({
    executable:
      repositorySelection.argumentsList[0] === "mcp" ||
      repositorySelection.argumentsList[2] === "mcp"
        ? "cloving-mcp"
        : "cloving-zapier",
    argumentsList: repositorySelection.argumentsList.slice(1),
    environment: {
      ...process.env,
      ...(runtime === undefined ? {} : { CLOVING_RUNTIME_DIR: runtime }),
    },
  });
} else {
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
    startHarness,
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
  if (
    invocation.kind === "watch" &&
    process.exitCode === threadPoolStallExitCode
  )
    await stalledExit(process);
}
