import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { parseCheckTimeFactor } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

export function hookTimeoutMilliseconds(factor: string | undefined): number {
  return 10000 * parseCheckTimeFactor(factor);
}

export const hookTimeout = hookTimeoutMilliseconds(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);

interface HookOptions {
  readonly expectedExit?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly arguments?: readonly string[];
}

interface HookResult {
  readonly exit: number | null;
  readonly diagnostic: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly context: string;
}

type HookInspector = (
  dispatch: (input: unknown, options?: HookOptions) => HookResult,
  directory: string,
) => Promise<void> | void;

export function hookEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    NODE_DISABLE_COMPILE_CACHE: "1",
    CLOVING_CHECK_TIME_FACTOR: process.env["CLOVING_CHECK_TIME_FACTOR"],
    CLOVING_WORKER_HOOK_TRACE: "1",
    ...overrides,
  };
}

export function hookFailureMessage(
  result: {
    readonly status: number | null;
    readonly signal: string | null;
    readonly error?: NodeJS.ErrnoException;
    readonly stderr: string | null;
  },
  started: number,
): string {
  return `Hook failed: elapsed=${String(Math.round(performance.now() - started))}ms signal=${result.signal ?? "none"} exit=${String(result.status)} error=${result.error?.code ?? "none"}\nstderr tail:\n${(result.stderr ?? "").slice(-4000)}`;
}

export function hookDiagnostic(stderr: string): string {
  return stderr.replace(/^\[cloving-worker-hook\] \d+ms \S+\n/gm, "");
}

function boundedAssertionDetail(value: unknown): string {
  if (typeof value === "string") return value.slice(-2000);
  return inspect(value, {
    depth: 4,
    maxArrayLength: 30,
    maxStringLength: 2000,
  }).slice(-2000);
}

export function runHook(
  command: HookOptions & {
    readonly arguments: readonly string[];
    readonly input?: string;
    readonly inputFile?: number;
    readonly timeout?: number;
  },
): HookResult {
  const started = performance.now();
  const result = spawnSync(process.execPath, command.arguments, {
    input: command.input,
    encoding: "utf8",
    timeout: command.timeout ?? hookTimeout,
    stdio: [command.inputFile ?? "pipe", "pipe", "pipe"],
    env: hookEnvironment(command.environment),
  });
  const context = hookFailureMessage(result, started);
  if (
    result.error ||
    result.signal !== null ||
    result.status !== (command.expectedExit ?? 2)
  )
    throw new Error(context);
  return {
    exit: result.status,
    diagnostic: hookDiagnostic(result.stderr),
    stderr: result.stderr,
    stdout: result.stdout,
    context,
  };
}

export function probeHookCheck(options: HookOptions = {}): HookResult {
  return runHook({
    arguments: [
      "--input-type=module",
      "-e",
      [
        "import childProcess from 'node:child_process';",
        "import { syncBuiltinESMExports } from 'node:module';",
        "childProcess.spawnSync = (_executable, arguments_, options) => {",
        "process.stdout.write(JSON.stringify({ check: arguments_[0], timeout: options.timeout }));",
        "return { status: 0, stderr: '' };",
        "};",
        "syncBuiltinESMExports();",
        "process.argv[2] = 'unused-policy.json';",
        `await import(${JSON.stringify(pathToFileURL(resolve("tools/worker-hook.ts")).href)});`,
      ].join("\n"),
    ],
    input: "{}",
    expectedExit: 0,
    ...options,
  });
}

export async function withHook(
  source: string,
  inspect: HookInspector,
): Promise<void> {
  await withFiles(
    {
      "workspace/main.ts": source,
      "workspace/package.json": '{"type":"module"}',
      "workspace/tsconfig.json": JSON.stringify({
        extends: resolve("tsconfig.json"),
        compilerOptions: { types: [] },
        include: ["main.ts"],
      }),
      "policy.json": "{}",
    },
    async (directory) => {
      const workspace = join(directory, "workspace");
      const policy = join(directory, "policy.json");
      await writeFile(
        policy,
        JSON.stringify({
          workspace,
          editableFiles: ["main.ts"],
          sourceFiles: ["main.ts"],
          compilerConfiguration: join(workspace, "tsconfig.json"),
        }),
      );
      let lastResult: HookResult | undefined;
      const dispatch = (input: unknown, options: HookOptions = {}) => {
        lastResult = runHook({
          arguments: [resolve("tools/worker-hook.ts"), policy],
          input: JSON.stringify(input),
          ...options,
        });
        return lastResult;
      };
      try {
        await inspect(dispatch, workspace);
      } catch (error) {
        if (!(error instanceof assert.AssertionError) || !lastResult)
          throw error;
        const message = `Hook assertion ${error.operator} failed\n${error.message.slice(-4000)}\n${lastResult.context}`;
        error.stack =
          error.stack?.replace(error.message, () => message) ?? message;
        error.message = message;
        error.actual = boundedAssertionDetail(error.actual);
        error.expected = boundedAssertionDetail(error.expected);
        throw error;
      }
    },
  );
}
