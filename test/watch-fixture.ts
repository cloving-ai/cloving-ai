import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const entry = join(import.meta.dirname, "../src/cli.ts");

export interface WatchOptions {
  readonly entry?: string;
  readonly port?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly directory?: string;
}

export interface Watching {
  readonly address: string;
  readonly stop: () => Promise<number | null>;
}

export interface Watched {
  readonly status: number | null;
  readonly output: string;
}

export function watchCommand(
  runtimeDirectory: string,
  selection: string | WatchOptions,
): { readonly child: ChildProcess; readonly output: { text: string } } {
  const options =
    typeof selection === "string" ? { port: selection } : selection;
  const child = spawn(
    process.execPath,
    [options.entry ?? entry, "watch", "--port", options.port ?? "0"],
    {
      env: {
        ...process.env,
        CLOVING_RUNTIME_DIR: runtimeDirectory,
        ...options.environment,
      },
      cwd: options.directory,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output.text += chunk.toString();
    });
  return { child, output };
}

function closed(child: ChildProcess): Promise<number | null> {
  return new Promise((settle) => {
    child.once("close", settle);
  });
}

export async function watching(
  runtimeDirectory: string,
  options: string | WatchOptions = "0",
): Promise<Watching> {
  const { child, output } = watchCommand(runtimeDirectory, options);
  const stop = (): Promise<number | null> => {
    const end = closed(child);
    child.kill("SIGTERM");
    return end;
  };
  for (let waited = 0; waited < 500; waited += 1) {
    const [, address] =
      /Watch page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output.text) ?? [];
    if (address !== undefined) return { address, stop };
    await delay(20);
  }
  await stop();
  throw new Error(`The watch command printed no address: ${output.text}`);
}

export async function refusedWatch(
  runtimeDirectory: string,
  port: string,
): Promise<Watched> {
  const { child, output } = watchCommand(runtimeDirectory, port);
  return { status: await closed(child), output: output.text };
}

export async function watchedModel(runtimeDirectory: string): Promise<unknown> {
  const watch = await watching(runtimeDirectory);
  try {
    const model: unknown = await (
      await fetch(`${watch.address}data.json`)
    ).json();
    return model;
  } finally {
    await watch.stop();
  }
}
