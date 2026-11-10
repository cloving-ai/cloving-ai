import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../protocol.ts";
import type { StreamResult } from "./claude-stream.ts";
import type { TurnLaunch } from "../turn-launch.ts";
import {
  processExists,
  processIdentity,
  processMatch,
} from "./process-identity.ts";
import {
  receivedLines,
  receivedText,
  streamEnd,
  streamState,
  type TurnProgress,
} from "./turn-stream.ts";

export type TurnExit = "exited" | "released";

export type LaunchState = "running" | "ended" | "gone";

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

interface Ending {
  readonly exitCode: number | null;
}

type Watch = Ending | "gone" | "released";

interface Followed {
  readonly processId: number | null;
  readonly launch: Promise<TurnLaunch | null>;
  readonly files: Pick<TurnLaunch, "output" | "offset" | "configuration">;
  readonly ending: (signal: AbortSignal) => Promise<Watch>;
  readonly signal: (name: NodeJS.Signals) => void;
}

const launcher = [
  'const{spawn}=require("node:child_process");',
  'const{renameSync,writeFileSync}=require("node:fs");',
  "const[exit,,command,...rest]=process.argv.slice(1);",
  'for(const name of["SIGTERM","SIGINT","SIGHUP"])process.on(name,()=>undefined);',
  'const child=spawn(command,rest,{stdio:"inherit"});',
  'child.on("error",(error)=>process.stderr.write(error.message+"\\n"));',
  'child.on("close",(exitCode,signal)=>{',
  'writeFileSync(exit+".tmp",JSON.stringify({exitCode,signal,endedAt:new Date().toISOString()})+"\\n",{mode:0o600});',
  'renameSync(exit+".tmp",exit);process.exit(0);});',
].join("");

const intervals = { output: 100, process: 250, identity: 16 } as const;

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function exitRecord(path: string): Promise<Ending | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  const fields = record(parsedJson(text ?? ""));
  if (fields === undefined) return undefined;
  const { exitCode } = fields;
  return { exitCode: typeof exitCode === "number" ? exitCode : null };
}

export async function launchState(launch: TurnLaunch): Promise<LaunchState> {
  if ((await exitRecord(launch.exit)) !== undefined) return "ended";
  if ((await processMatch(launch)) !== "other") return "running";
  return (await exitRecord(launch.exit)) === undefined ? "gone" : "ended";
}

function signalGroup(processId: number, name: NodeJS.Signals): void {
  try {
    process.kill(-processId, name);
  } catch {
    return;
  }
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

function released(signal: AbortSignal): Promise<Watch> {
  return new Promise((settle) => {
    if (signal.aborted) settle("released");
    signal.addEventListener("abort", () => {
      settle("released");
    });
  });
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
  const path = join(start.folder, "turn.prompt");
  writeFileSync(path, start.standardInput, { mode: 0o600 });
  const descriptor = openSync(path, "r");
  rmSync(path);
  return descriptor;
}

function launchFiles(start: DetachedStart) {
  const path = join(start.activityFolder ?? start.folder, "turn.jsonl");
  const output = openSync(path, start.activityFolder === undefined ? "w" : "a");
  if (start.activityFolder !== undefined) writeSync(output, "\n");
  const offset = fstatSync(output).size;
  const error = openSync(join(start.folder, "turn.stderr.log"), "w");
  const exit = join(start.folder, "turn.exit.json");
  rmSync(exit, { force: true });
  return {
    path,
    offset,
    exit,
    descriptors: [promptInput(start), output, error] as const,
  };
}

function spawnedLauncher(
  start: DetachedStart,
  files: ReturnType<typeof launchFiles> & { readonly marker: string },
): ChildProcess {
  const [input, output, error] = files.descriptors;
  try {
    return spawn(
      process.execPath,
      [
        "-e",
        launcher,
        files.exit,
        files.marker,
        start.executable,
        ...start.arguments,
      ],
      {
        cwd: start.directory,
        env: start.environment,
        stdio: [input, output, error],
        detached: true,
      },
    );
  } finally {
    for (const descriptor of files.descriptors)
      if (typeof descriptor === "number") closeSync(descriptor);
  }
}

function childEnding(child: ChildProcess, exit: string): Promise<Watch> {
  return new Promise<void>((settle) => {
    child.once("exit", () => {
      settle();
    });
    child.once("error", () => {
      settle();
    });
  }).then(async () => (await exitRecord(exit)) ?? { exitCode: null });
}

export function detachedTurn(start: DetachedStart): FollowedTurn {
  const files = {
    ...launchFiles(start),
    marker: `cloving-turn-${randomUUID()}`,
  };
  const child = spawnedLauncher(start, files);
  child.unref();
  const processId = child.pid ?? null;
  const launch = (
    processId === null ? Promise.resolve(undefined) : processIdentity(processId)
  ).then((identity) =>
    identity === undefined || processId === null
      ? null
      : {
          processId,
          processStart: identity.start,
          marker: files.marker,
          output: files.path,
          offset: files.offset,
          exit: files.exit,
          configuration: start.configuration,
        },
  );
  return followed(start, {
    processId,
    launch,
    files: { ...files, output: files.path, configuration: start.configuration },
    ending: (signal) =>
      Promise.race([childEnding(child, files.exit), released(signal)]),
    signal: (name) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (processId !== null) signalGroup(processId, name);
    },
  });
}

async function running(launch: TurnLaunch, poll: number): Promise<boolean> {
  if (!processExists(launch.processId)) return false;
  if (poll % intervals.identity !== 0) return true;
  return (await processMatch(launch)) !== "other";
}

async function launchEnding(
  launch: TurnLaunch,
  signal: AbortSignal,
): Promise<Watch> {
  for (let poll = 0; ; poll += 1) {
    const ending = await exitRecord(launch.exit);
    if (ending !== undefined) return ending;
    if (!(await running(launch, poll)))
      return (await exitRecord(launch.exit)) ?? "gone";
    const waited = await delay(intervals.process, true, { signal }).catch(
      () => false,
    );
    if (!waited) return "released";
  }
}

async function sameSignalled(
  launch: TurnLaunch,
  name: NodeJS.Signals,
): Promise<void> {
  if ((await processMatch(launch)) === "same")
    signalGroup(launch.processId, name);
}

export function attachedTurn(
  start: FollowStart,
  launch: TurnLaunch,
): FollowedTurn {
  return followed(start, {
    processId: launch.processId,
    launch: Promise.resolve(launch),
    files: launch,
    ending: (signal) => launchEnding(launch, signal),
    signal: (name) => {
      sameSignalled(launch, name).catch(() => undefined);
    },
  });
}
