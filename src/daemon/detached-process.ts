import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../protocol.ts";
import {
  piRpcLauncherModule,
  preparePiRpc,
  type PiRpcStart,
} from "./pi-rpc-launcher.ts";
import {
  recordedLaunch,
  type PlannedLaunch,
  type TurnLaunch,
} from "../turn-launch.ts";
import {
  markedProcesses,
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
  readonly reason?: string;
  readonly endedAt?: number;
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
  readonly piRpc?: PiRpcStart;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly directory: string;
  readonly descriptors: readonly [number | "ignore", number, number];
  readonly marker: LaunchMarker;
  readonly limits?: LauncherLimits;
}

export interface LaunchMarker {
  readonly path: string;
  readonly launch: PlannedLaunch;
}

export interface LauncherLimits {
  readonly milliseconds: number;
  readonly reason: string;
  readonly outputBytes: number;
  readonly errorBytes: number;
}

export const intervals = { output: 100, process: 250, identity: 16 } as const;

const launcher = [
  'const{spawn,execFileSync}=require("node:child_process");',
  'const{fstatSync,renameSync,writeFileSync}=require("node:fs");',
  "const[exit,marker,coverage,limitText,rpcModule,rpcText,command,...rest]=process.argv.slice(1);",
  "const startedAt=Date.now();let processStart;",
  'try{processStart=execFileSync("ps",["-o","lstart=",String(process.pid)],{encoding:"utf8",timeout:5000,env:{...process.env,LC_ALL:"C"}}).trim().split(/\\s+/).join(" ");}catch{}',
  "const limits=JSON.parse(limitText);",
  'let rpcStopped=false;let rpcStop=()=>undefined;const closing=(phase)=>{try{return rpcStop(phase);}catch{return "pi-rpc-control-failed";}};for(const name of["SIGTERM","SIGINT","SIGHUP"])process.on(name,()=>{rpcStopped=true;closing("stop");});',
  "const env={...process.env};",
  'if(coverage!=="")env.NODE_V8_COVERAGE=coverage;',
  "let ended=false;",
  "const ending=(fields)=>{if(ended)return false;ended=true;",
  'writeFileSync(exit+".tmp",JSON.stringify({...fields,processId:process.pid,processStart,marker,startedAt,endedAt:new Date().toISOString()})+"\\n",{mode:0o600});',
  'renameSync(exit+".tmp",exit);return true;};',
  'const stopped=(reason)=>{closing("stop");let first=true;try{first=ending({exitCode:null,signal:"SIGKILL",reason});}finally{if(first)process.kill(-process.pid,"SIGKILL");}};',
  "const rpc=JSON.parse(rpcText);",
  'const child=spawn(command,rest,{stdio:rpc===null?"inherit":["pipe","pipe","inherit"],env});',
  'if(rpc!==null)import(rpcModule).then(({attachPiRpc})=>{if(rpcStopped){stopped("pi-rpc-stopped-before-input");return;}rpcStop=attachPiRpc(child,{start:rpc,owner:{processId:process.pid,processStart,marker},stop:stopped});}).catch(()=>{stopped("pi-rpc-control-failed");});',
  'child.on("error",()=>undefined);',
  "const limited=limits.milliseconds!==undefined||limits.outputBytes!==undefined;",
  'child.on("close",(exitCode,signal)=>{const reason=closing("exit");ending({exitCode,signal,...(reason===undefined?{}:{reason,exitCode:null})});if(limited)try{process.kill(-process.pid,"SIGKILL");}catch{}process.exit(0);});',
  "if(limits.milliseconds!==undefined)setTimeout(()=>{stopped(limits.reason);},limits.milliseconds);",
  "const over=(descriptor,bytes)=>fstatSync(descriptor).size>bytes;",
  "if(limits.outputBytes!==undefined)setInterval(()=>{",
  'if(over(1,limits.outputBytes)||over(2,limits.errorBytes))stopped("command-output-limit");',
  `},${String(intervals.output)});`,
].join("");

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
  const { exitCode, reason, endedAt } = fields;
  const ended = typeof endedAt === "string" ? Date.parse(endedAt) : NaN;
  return {
    exitCode: typeof exitCode === "number" ? exitCode : null,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(Number.isFinite(ended) ? { endedAt: ended } : {}),
  };
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

function spawnedLauncher(start: LauncherStart): ChildProcess {
  const { NODE_V8_COVERAGE: coverage = "", ...environment } = start.environment;
  const { path, launch } = start.marker;
  try {
    if (start.piRpc !== undefined) preparePiRpc(start.piRpc, launch.marker);
    rmSync(launch.exit, { force: true });
    writeFileSync(`${path}.staged`, JSON.stringify(launch), { mode: 0o600 });
    renameSync(`${path}.staged`, path);
    return spawn(
      process.execPath,
      [
        "-e",
        launcher,
        launch.exit,
        launch.marker,
        coverage,
        JSON.stringify(start.limits ?? {}),
        piRpcLauncherModule,
        JSON.stringify(start.piRpc ?? null),
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
  const { marker, exit } = start.marker.launch;
  const child = spawnedLauncher(start);
  child.unref();
  const processId = child.pid ?? null;
  const launch = (
    processId === null ? Promise.resolve(undefined) : processIdentity(processId)
  ).then((identity) =>
    identity === undefined || processId === null
      ? null
      : { processId, processStart: identity.start, marker, exit },
  );
  return {
    child,
    processId,
    launch,
    ending: (signal) => {
      child.ref();
      const release = released(signal).finally(() => {
        child.unref();
      });
      return Promise.race([childEnding(child, exit), release]);
    },
    signal: (name) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (processId !== null) signalGroup(processId, name);
    },
  };
}

async function running(
  launch: RecordedProcess,
  poll: number,
): Promise<boolean> {
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
  launch: RecordedProcess,
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

export async function stoppedLaunch(
  launch: ProcessLaunch,
  milliseconds: number,
): Promise<void> {
  const kept = attachedProcess(launch);
  kept.signal("SIGTERM");
  const forced = setTimeout(() => {
    kept.signal("SIGKILL");
  }, milliseconds);
  try {
    await kept.ending(new AbortController().signal);
  } finally {
    clearTimeout(forced);
  }
}

export const markerRecord = "launch-marker.json";

export function launchMarker(
  folder: string,
  files: Omit<PlannedLaunch, "marker">,
): LaunchMarker {
  return {
    path: join(folder, markerRecord),
    launch: { marker: `cloving-turn-${randomUUID()}`, ...files },
  };
}

async function stoppedMatch(
  found: RecordedProcess,
  milliseconds: number,
): Promise<void> {
  const watching = new AbortController();
  const signalled = (name: NodeJS.Signals) =>
    sameSignalled(found, { name, watching: watching.signal });
  const forced = setTimeout(() => {
    signalled("SIGKILL").catch(() => undefined);
  }, milliseconds);
  try {
    await signalled("SIGTERM");
    for (let poll = 0; await running(found, poll); poll += 1)
      await delay(intervals.process);
  } finally {
    clearTimeout(forced);
    watching.abort();
  }
}

export interface FoundLaunch {
  readonly launch: TurnLaunch;
  readonly startedAt: number;
}

function completedStart(fields: Record<string, unknown>, since: number) {
  const { startedAt, endedAt, exitCode } = fields;
  const ended = typeof endedAt === "string" ? Date.parse(endedAt) : NaN;
  const validExit = exitCode === null || Number.isSafeInteger(exitCode);
  return typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    startedAt >= since &&
    ended >= startedAt &&
    validExit
    ? startedAt
    : undefined;
}

export async function completedLaunch(
  planned: PlannedLaunch,
  since: number,
): Promise<FoundLaunch | "unknown" | undefined> {
  const text = await readFile(planned.exit, "utf8").catch(() => "");
  const fields = record(parsedJson(text));
  if (fields === undefined || fields["marker"] !== planned.marker)
    return undefined;
  const launch = recordedLaunch({ ...fields, ...planned });
  const startedAt = completedStart(fields, since);
  if (
    launch === undefined ||
    startedAt === undefined ||
    !Number.isFinite(Date.parse(launch.processStart))
  )
    return undefined;
  if (processExists(launch.processId)) return "unknown";
  return { launch, startedAt };
}

export async function foundLaunch(
  planned: PlannedLaunch,
  search: { readonly since: number; readonly stopMilliseconds: number },
): Promise<FoundLaunch | "stopped" | "unknown" | undefined> {
  const found = await markedProcesses({ ...search, marker: planned.marker });
  if (found === undefined) return "unknown";
  const launches = found.map(({ processId, processStart, startedAt }) => ({
    launch: { processId, processStart, ...planned },
    startedAt,
  }));
  if (launches.length === 1) return launches[0];
  await Promise.all(
    launches.map((match) =>
      stoppedMatch(match.launch, search.stopMilliseconds),
    ),
  );
  return launches.length === 0 ? undefined : "stopped";
}
