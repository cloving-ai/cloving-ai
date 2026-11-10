import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../protocol.ts";
import {
  processExists,
  processIdentity,
  processMatch,
  type RecordedProcess,
} from "./process-identity.ts";

export interface ProcessLaunch extends RecordedProcess {
  readonly exit: string;
}

export type LaunchState = "running" | "ended" | "gone";

export interface Ending {
  readonly exitCode: number | null;
}

export type Watch = Ending | "gone" | "released";

export interface DetachedProcess {
  readonly processId: number | null;
  readonly launch: Promise<ProcessLaunch | null>;
  readonly ending: (signal: AbortSignal) => Promise<Watch>;
  readonly signal: (name: NodeJS.Signals) => void;
}

export interface LaunchedProcess extends DetachedProcess {
  readonly child: ChildProcess;
}

export interface LauncherStart {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly directory: string;
  readonly descriptors: readonly [number | "ignore", number, number];
  readonly exit: string;
}

const launcher = [
  'const{spawn}=require("node:child_process");',
  'const{renameSync,writeFileSync}=require("node:fs");',
  "const[exit,,coverage,command,...rest]=process.argv.slice(1);",
  'for(const name of["SIGTERM","SIGINT","SIGHUP"])process.on(name,()=>undefined);',
  "const env={...process.env};",
  'if(coverage!=="")env.NODE_V8_COVERAGE=coverage;',
  'const child=spawn(command,rest,{stdio:"inherit",env});',
  'child.on("error",()=>undefined);',
  'child.on("close",(exitCode,signal)=>{',
  'writeFileSync(exit+".tmp",JSON.stringify({exitCode,signal,endedAt:new Date().toISOString()})+"\\n",{mode:0o600});',
  'renameSync(exit+".tmp",exit);process.exit(0);});',
].join("");

export const intervals = { output: 100, process: 250, identity: 16 } as const;

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

export async function launchState(launch: ProcessLaunch): Promise<LaunchState> {
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

export function inputDescriptor(file: {
  readonly path: string;
  readonly text: string;
}): number {
  try {
    writeFileSync(file.path, file.text, { mode: 0o600 });
    return openSync(file.path, "r");
  } finally {
    rmSync(file.path, { force: true });
  }
}

export function released(signal: AbortSignal): Promise<Watch> {
  return new Promise((settle) => {
    if (signal.aborted) settle("released");
    signal.addEventListener("abort", () => {
      settle("released");
    });
  });
}

function spawnedLauncher(
  start: LauncherStart & { readonly marker: string },
): ChildProcess {
  const { NODE_V8_COVERAGE: coverage = "", ...environment } = start.environment;
  try {
    rmSync(start.exit, { force: true });
    return spawn(
      process.execPath,
      [
        "-e",
        launcher,
        start.exit,
        start.marker,
        coverage,
        start.executable,
        ...start.arguments,
      ],
      {
        cwd: start.directory,
        env: { ...environment, NODE_V8_COVERAGE: undefined },
        stdio: [...start.descriptors],
        detached: true,
      },
    );
  } finally {
    for (const descriptor of start.descriptors)
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

export function launchedProcess(start: LauncherStart): LaunchedProcess {
  const marker = `cloving-turn-${randomUUID()}`;
  const child = spawnedLauncher({ ...start, marker });
  child.unref();
  const processId = child.pid ?? null;
  const launch = (
    processId === null ? Promise.resolve(undefined) : processIdentity(processId)
  ).then((identity) =>
    identity === undefined || processId === null
      ? null
      : { processId, processStart: identity.start, marker, exit: start.exit },
  );
  return {
    child,
    processId,
    launch,
    ending: (signal) =>
      Promise.race([childEnding(child, start.exit), released(signal)]),
    signal: (name) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (processId !== null) signalGroup(processId, name);
    },
  };
}

async function running(launch: ProcessLaunch, poll: number): Promise<boolean> {
  if (!processExists(launch.processId)) return false;
  if (poll % intervals.identity !== 0) return true;
  return (await processMatch(launch)) !== "other";
}

async function launchEnding(
  launch: ProcessLaunch,
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
  launch: ProcessLaunch,
  request: { readonly name: NodeJS.Signals; readonly watching: AbortSignal },
): Promise<void> {
  for (;;) {
    const match = await processMatch(launch);
    if (match === "same") signalGroup(launch.processId, request.name);
    if (match !== "unknown") return;
    await delay(intervals.process, undefined, { signal: request.watching });
  }
}

export function attachedProcess(launch: ProcessLaunch): DetachedProcess {
  const watching = new AbortController();
  return {
    processId: launch.processId,
    launch: Promise.resolve(launch),
    ending: (signal) =>
      launchEnding(launch, signal).finally(() => {
        watching.abort();
      }),
    signal: (name) => {
      sameSignalled(launch, { name, watching: watching.signal }).catch(
        () => undefined,
      );
    },
  };
}
