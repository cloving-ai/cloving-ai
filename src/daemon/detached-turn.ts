import { closeSync, fstatSync, openSync, rmSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { StreamResult } from "./claude-stream.ts";
import type { LaterAttempt } from "./turn-activity.ts";
import type { RunnerPlace, TurnLaunch } from "../turn-launch.ts";
import { runnerRefused } from "../turn-runner.ts";
import { releasedRunner } from "./turn-runner-spawn.ts";
import {
  attachedProcess,
  inputDescriptor,
  intervals,
  launchedProcess,
  type Watch,
} from "./detached-process.ts";
import type { TurnProgress } from "./turn-stream.ts";
import {
  harnessReader,
  translatedHarness,
  type HarnessReader,
} from "./harness-reader.ts";

export type TurnExit = "exited" | "released";

export interface FollowedTurn {
  readonly processId: number | null;
  readonly launch: Promise<TurnLaunch | null>;
  readonly exited: Promise<TurnExit>;
  readonly ended: Promise<{
    readonly exitCode: number | null;
    readonly reason?: string;
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
  readonly laterAttempt?: LaterAttempt | undefined;
  readonly standardInput: string | undefined;
  readonly configuration: string;
  readonly runnerPlace?: RunnerPlace;
}

interface Followed {
  readonly processId: number | null;
  readonly launch: Promise<TurnLaunch | null>;
  readonly files: Pick<
    TurnLaunch,
    "output" | "offset" | "configuration" | "exit" | "transcript" | "runner"
  >;
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

function transcriptWriter(transcript: TurnLaunch["transcript"]) {
  if (transcript === undefined)
    return { write: () => undefined, close: () => undefined };
  const descriptor = openSync(transcript.path, "a");
  let written = Math.max(0, fstatSync(descriptor).size - transcript.offset);
  let open = true;
  return {
    write: (text: string) => {
      const bytes = Buffer.from(text, "utf8");
      const skipped = Math.min(written, bytes.length);
      written -= skipped;
      if (skipped < bytes.length) writeSync(descriptor, bytes, skipped);
    },
    close: () => {
      if (open) closeSync(descriptor);
      open = false;
    },
  };
}

async function errorText(path: string, reader: HarnessReader): Promise<string> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return "";
  const decoder = new TextDecoder("utf-8");
  const buffer = Buffer.alloc(65_536);
  let head = "";
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      const text = decoder.decode(buffer.subarray(0, bytesRead), {
        stream: bytesRead > 0,
      });
      if (head.length < 65_536) head += text;
      reader.error?.(text);
      const enough = reader.error === undefined && head.length >= 65_536;
      if (bytesRead === 0 || enough) return head.slice(0, 65_536);
    }
  } finally {
    await handle.close();
  }
}

async function concluded(
  files: Followed["files"],
  ending: { readonly reader: HarnessReader; readonly exitCode: number | null },
) {
  const { reader, exitCode } = ending;
  const unread = files.runner === undefined && reader.error === undefined;
  const error = unread
    ? ""
    : await errorText(join(dirname(files.exit), "turn.stderr.log"), reader);
  const reason =
    files.runner === undefined ? undefined : runnerRefused({ exitCode, error });
  reader.finish({ exitCode, refused: reason !== undefined });
  const result = await reader.result();
  if (reason === undefined) return { exitCode, result };
  return { exitCode, reason, result: undefined };
}

export async function releasedLaunch(
  launch: Pick<TurnLaunch, "configuration" | "runner">,
): Promise<void> {
  rmSync(launch.configuration, { recursive: true, force: true });
  await releasedRunner(launch.runner, process.env);
}

function followed(start: FollowStart, parts: Followed) {
  const transcript = transcriptWriter(parts.files.transcript);
  const reader = harnessReader(
    {
      ...start,
      failed: () => {
        parts.signal("SIGKILL");
      },
    },
    transcript.write,
  );
  const output = outputReader(parts.files, reader.text);
  const watching = new AbortController();
  const release = () => {
    watching.abort();
  };
  start.release?.addEventListener("abort", release, { once: true });
  if (start.release?.aborted === true) release();
  const watch = pumped(output, parts.ending(watching.signal));
  const timers: NodeJS.Timeout[] = [];
  const ended = watch.then(async (state) => {
    start.release?.removeEventListener("abort", release);
    timers.forEach(clearTimeout);
    if (state === "released") {
      transcript.close();
      throw new Error("turn-released");
    }
    try {
      return await concluded(parts.files, {
        reader,
        exitCode: state === "gone" ? null : state.exitCode,
      });
    } finally {
      transcript.close();
      await releasedLaunch(parts.files);
    }
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

function transcriptFile(start: DetachedStart) {
  const { laterAttempt } = start;
  const path = join(laterAttempt?.folder ?? start.folder, "turn.jsonl");
  const descriptor = openSync(path, laterAttempt === undefined ? "w" : "a");
  if (laterAttempt !== undefined) writeSync(descriptor, "\n");
  return { descriptor, path, offset: fstatSync(descriptor).size };
}

function outputFile(start: DetachedStart) {
  const transcript = transcriptFile(start);
  if (!translatedHarness(start.worker)) return transcript;
  closeSync(transcript.descriptor);
  const path = join(start.folder, "turn.harness.jsonl");
  return {
    descriptor: openSync(path, "w"),
    path,
    offset: 0,
    transcript: { path: transcript.path, offset: transcript.offset },
  };
}

function launchFiles(start: DetachedStart) {
  const output = outputFile(start);
  const error = openSync(join(start.folder, "turn.stderr.log"), "w");
  return {
    ...output,
    exit: join(start.folder, "turn.exit.json"),
    descriptors: [promptInput(start), output.descriptor, error] as const,
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
  const recordedFiles = {
    output: files.path,
    offset: files.offset,
    exit: files.exit,
    configuration: start.configuration,
    ...("transcript" in files ? { transcript: files.transcript } : {}),
    ...(start.runnerPlace === undefined ? {} : { runner: start.runnerPlace }),
  };
  const launch = detached.launch.then((recorded) =>
    recorded === null ? null : { ...recorded, ...recordedFiles },
  );
  return followed(start, { ...detached, launch, files: recordedFiles });
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
