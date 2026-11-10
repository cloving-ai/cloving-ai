import { fstatSync, openSync, rmSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { StreamResult } from "./claude-stream.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import {
  attachedProcess,
  inputDescriptor,
  intervals,
  launchedProcess,
  type Watch,
} from "./detached-process.ts";
import {
  receivedLines,
  receivedText,
  streamEnd,
  streamState,
  type TurnProgress,
} from "./turn-stream.ts";

export type TurnExit = "exited" | "released";

export interface FollowedTurn {
  readonly processId: number | null;
  readonly launch: Promise<TurnLaunch | null>;
  readonly exited: Promise<TurnExit>;
  readonly ended: Promise<{
    readonly exitCode: number | null;
    readonly result: StreamResult | undefined;
  }>;
  readonly stop: (graceMilliseconds: number) => void;
}

export interface FollowStart {
  readonly progress?: ((progress: TurnProgress) => Promise<void>) | undefined;
  readonly worker?: string | undefined;
  readonly command: readonly string[];
  readonly release?: AbortSignal | undefined;
}

export interface DetachedStart extends FollowStart {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly directory: string;
  readonly folder: string;
  readonly activityFolder?: string | undefined;
  readonly standardInput: string | undefined;
  readonly configuration: string;
}

interface Followed {
  readonly processId: number | null;
  readonly launch: Promise<TurnLaunch | null>;
  readonly files: Pick<TurnLaunch, "output" | "offset" | "configuration">;
  readonly ending: (signal: AbortSignal) => Promise<Watch>;
  readonly signal: (name: NodeJS.Signals) => void;
}

function outputReader(
  files: Followed["files"],
  received: (text: string) => void,
) {
  let position = files.offset;
  let handle: Promise<FileHandle | undefined> | undefined;
  const decoder = new TextDecoder("utf-8");
  const buffer = Buffer.alloc(65_536);
  const opened = () =>
    (handle ??= open(files.output, "r").catch(() => undefined));
  return {
    read: async (): Promise<void> => {
      const file = await opened();
      for (;;) {
        const read = await file?.read(buffer, 0, buffer.length, position);
        const bytes = read?.bytesRead ?? 0;
        if (bytes === 0) return;
        position += bytes;
        received(decoder.decode(buffer.subarray(0, bytes), { stream: true }));
      }
    },
    close: async (): Promise<void> => {
      received(decoder.decode());
      await (await opened())?.close();
    },
  };
}

async function pumped(
  reader: ReturnType<typeof outputReader>,
  watch: Promise<Watch>,
): Promise<Watch> {
  for (;;) {
    await reader.read();
    const next = await Promise.race([
      watch,
      delay(intervals.output).then(() => undefined),
    ]);
    if (next === undefined) continue;
    if (next !== "released") await reader.read();
    await reader.close();
    return next;
  }
}

function followed(start: FollowStart, parts: Followed) {
  const stream = streamState();
  const input = {
    progress: start.progress,
    worker: start.worker,
    failed: () => {
      parts.signal("SIGKILL");
    },
  };
  const reader = outputReader(parts.files, (text) => {
    receivedText(stream, { ...input, text });
  });
  const watching = new AbortController();
  const release = () => {
    watching.abort();
  };
  start.release?.addEventListener("abort", release, { once: true });
  if (start.release?.aborted === true) release();
  const watch = pumped(reader, parts.ending(watching.signal));
  const timers: NodeJS.Timeout[] = [];
  const ended = watch.then(async (state) => {
    start.release?.removeEventListener("abort", release);
    timers.forEach(clearTimeout);
    if (state === "released") throw new Error("turn-released");
    rmSync(parts.files.configuration, { recursive: true, force: true });
    receivedLines(stream, { ...input, lines: [stream.pending] });
    const exitCode = state === "gone" ? null : state.exitCode;
    return { exitCode, result: await streamEnd(stream, start.command) };
  });
  return {
    processId: parts.processId,
    launch: parts.launch,
    exited: watch.then(
      (state): TurnExit => (state === "released" ? "released" : "exited"),
      (): TurnExit => "exited",
    ),
    ended,
    stop: (graceMilliseconds: number) => {
      if (watching.signal.aborted) return;
      parts.signal("SIGTERM");
      timers.push(
        setTimeout(() => {
          parts.signal("SIGKILL");
        }, graceMilliseconds).unref(),
      );
    },
  };
}

function promptInput(start: DetachedStart): number | "ignore" {
  if (start.standardInput === undefined) return "ignore";
  return inputDescriptor({
    path: join(start.folder, "turn.prompt"),
    text: start.standardInput,
  });
}

function launchFiles(start: DetachedStart) {
  const path = join(start.activityFolder ?? start.folder, "turn.jsonl");
  const output = openSync(path, start.activityFolder === undefined ? "w" : "a");
  if (start.activityFolder !== undefined) writeSync(output, "\n");
  const offset = fstatSync(output).size;
  const error = openSync(join(start.folder, "turn.stderr.log"), "w");
  const exit = join(start.folder, "turn.exit.json");
  return {
    path,
    offset,
    exit,
    descriptors: [promptInput(start), output, error] as const,
  };
}

export function detachedTurn(start: DetachedStart): FollowedTurn {
  const files = launchFiles(start);
  const detached = launchedProcess({
    executable: start.executable,
    arguments: start.arguments,
    environment: start.environment,
    directory: start.directory,
    descriptors: files.descriptors,
    exit: files.exit,
  });
  const launch = detached.launch.then((recorded) =>
    recorded === null
      ? null
      : {
          ...recorded,
          output: files.path,
          offset: files.offset,
          configuration: start.configuration,
        },
  );
  return followed(start, {
    ...detached,
    launch,
    files: {
      output: files.path,
      offset: files.offset,
      configuration: start.configuration,
    },
  });
}

export function attachedTurn(
  start: FollowStart,
  launch: TurnLaunch,
): FollowedTurn {
  return followed(start, {
    ...attachedProcess(launch),
    launch: Promise.resolve(launch),
    files: launch,
  });
}
