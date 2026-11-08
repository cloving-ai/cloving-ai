import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stopChildGroup } from "./stop-child.ts";
import { testMilliseconds } from "./test-timing.ts";

export const entry = resolve("src/cli.ts");
const guideEnd = "Commands for a second terminal:";

export function hostEnvironment(state: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOVING_RUNTIME_DIR: undefined,
    CLOVING_SELF_UPDATE_SECONDS: undefined,
    CLOVING_QUEUE_SECONDS: undefined,
    CLOVING_WORKER: "claude",
    CLOVING_NOTIFY_COMMAND: undefined,
    CLOVING_CLAUDE_COMMAND: JSON.stringify([
      process.execPath,
      "-e",
      "process.exit(1)",
    ]),
    CLOVING_WATCH_PORT: "off",
    XDG_RUNTIME_DIR: "",
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config"),
  };
}

export async function writtenWorkspace(
  state: string,
  repositories: readonly { readonly path: string; readonly name: string }[],
): Promise<void> {
  await mkdir(join(state, "config/cloving"), { recursive: true });
  await writeFile(
    join(state, "config/cloving/workspace.json"),
    JSON.stringify({ version: 1, repositories }),
  );
}

export function closed(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise((settle) => {
    child.once("close", settle);
  });
}

export async function workspaceStarted(input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly guides: number;
}) {
  const child = spawn(process.execPath, [entry, "start", "--workspace"], {
    cwd: input.cwd,
    env: input.environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  const ready = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    ready.reject(new Error(output.text || "start timed out"));
  }, testMilliseconds(60000));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output.text += chunk.toString();
      if (output.text.split(guideEnd).length > input.guides)
        ready.resolve(undefined);
    });
  child.once("close", () => {
    ready.reject(new Error(output.text));
  });
  try {
    await ready.promise;
    return { child, output };
  } catch (error) {
    await stopChildGroup(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
