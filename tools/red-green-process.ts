import { spawn, type ChildProcess } from "node:child_process";
import { addAbortListener } from "node:events";

export interface RunResult {
  readonly status: number | null;
  readonly output: string;
  readonly prepareFailed?: boolean;
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") child.kill("SIGKILL");
  }
}

export async function redGreenProcess(
  argumentsList: readonly string[],
  options: {
    readonly directory: string;
    readonly signal: AbortSignal;
    readonly milliseconds: number;
  },
): Promise<RunResult> {
  options.signal.throwIfAborted();
  const child = spawn(argumentsList[0] ?? "", argumentsList.slice(1), {
    cwd: options.directory,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  let output = "";
  let stopped = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  child.once("error", (error) => {
    output += error.message;
  });
  const closed = new Promise<RunResult>((resolve) => {
    child.once("close", (status) => {
      resolve({ status: stopped ? null : status, output });
    });
  });
  const terminate = (): void => {
    stopped = true;
    stop(child);
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const listener = addAbortListener(options.signal, terminate);
  const timeout = setTimeout(() => {
    output += "\nred-green command timed out\n";
    terminate();
  }, options.milliseconds);
  try {
    return await closed;
  } finally {
    clearTimeout(timeout);
    listener[Symbol.dispose]();
    stop(child);
  }
}
