import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { writeRecord } from "./operation-journal.ts";

const execute = promisify(execFile);
const limits = {
  encoding: "utf8",
  timeout: 5000,
  maxBuffer: 8 * 1024 * 1024,
} as const;

interface TreeProcess {
  readonly processId: number;
  readonly group: number;
  readonly user: number;
  readonly seconds: number;
  readonly command: string;
  readonly directory?: string;
}

async function output(command: string, arguments_: readonly string[]) {
  return (await execute(command, arguments_, limits)).stdout;
}

function settledOutput(
  command: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((settle) => {
    execFile(command, arguments_, limits, (_error, stdout) => {
      settle(stdout);
    });
  });
}

async function procDirectories(
  entries: readonly string[],
): Promise<ReadonlyMap<number, string>> {
  const links = await Promise.all(
    entries.map(async (entry) => {
      const directory = await readlink(`/proc/${entry}/cwd`).catch(
        () => undefined,
      );
      return [Number(entry), directory] as const;
    }),
  );
  return new Map(
    links.filter(
      (entry): entry is readonly [number, string] => entry[1] !== undefined,
    ),
  );
}

function lsofDirectories(text: string): ReadonlyMap<number, string> {
  const found = new Map<number, string>();
  let processId = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) processId = Number(line.slice(1));
    if (line.startsWith("n")) found.set(processId, line.slice(1));
  }
  return found;
}

async function directories(
  processIds?: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const fields = ["-d", "cwd", "-Fpn", "-n", "-P"];
  if (process.platform === "linux")
    return procDirectories(
      processIds?.map(String) ??
        (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)),
    );
  return lsofDirectories(
    processIds === undefined
      ? await output("lsof", fields)
      : await settledOutput("lsof", [
          "-a",
          "-p",
          processIds.join(","),
          ...fields,
        ]),
  );
}

export function elapsedSeconds(text: string): number {
  const days = text.includes("-") ? Number.parseInt(text, 10) : 0;
  const clock = text.slice(text.indexOf("-") + 1);
  return (
    days * 86_400 +
    clock.split(":").reduce((total, part) => total * 60 + Number(part), 0)
  );
}

async function table(): Promise<readonly TreeProcess[]> {
  const text = await output("ps", ["-axo", "pid=,pgid=,uid=,etime=,comm="]);
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const [
        processId = "0",
        group = "0",
        user = "-1",
        elapsed = "",
        ...command
      ] = line.trim().split(/\s+/);
      return {
        processId: Number(processId),
        group: Number(group),
        user: Number(user),
        seconds: elapsedSeconds(elapsed),
        command: command.join(" "),
      };
    });
}

function located(
  entries: readonly TreeProcess[],
  working: ReadonlyMap<number, string>,
): readonly TreeProcess[] {
  return entries.map((entry) => {
    const directory = working.get(entry.processId);
    return { ...entry, ...(directory === undefined ? {} : { directory }) };
  });
}

async function processes(): Promise<readonly TreeProcess[] | undefined> {
  try {
    return located(await table(), await directories());
  } catch {
    return undefined;
  }
}

async function youngProcesses(
  seconds: number,
): Promise<readonly TreeProcess[] | undefined> {
  try {
    const entries = await table();
    const young = entries.filter(
      (entry) =>
        entry.user === process.getuid?.() &&
        entry.processId !== process.pid &&
        entry.seconds <= seconds,
    );
    if (young.length === 0) return entries;
    return located(
      entries,
      await directories(young.map((entry) => entry.processId)),
    );
  } catch {
    return undefined;
  }
}

function inTree(entry: TreeProcess, directory: string): boolean {
  if (
    entry.processId <= 1 ||
    entry.processId === process.pid ||
    entry.directory === undefined
  )
    return false;
  const root = resolve(directory);
  return entry.directory === root || entry.directory.startsWith(root + sep);
}

export async function recordedProcessDirectory(
  processId: number,
): Promise<string | undefined> {
  return (await processes())?.find((entry) => entry.processId === processId)
    ?.directory;
}

function terminate(
  entries: readonly TreeProcess[],
  request: { readonly directory: string; readonly signal: NodeJS.Signals },
): TreeProcess[] {
  const { directory, signal } = request;
  const maySignal = (entry: TreeProcess) =>
    entry.user === process.getuid?.() && inTree(entry, directory);
  const found = entries.filter(maySignal);
  const groups = new Set<number>();
  for (const entry of found) {
    const safeGroup =
      entry.group > 1 &&
      entries.filter((other) => other.group === entry.group).every(maySignal);
    const target = safeGroup ? -entry.group : entry.processId;
    if (groups.has(target)) continue;
    groups.add(target);
    try {
      process.kill(target, signal);
    } catch {
      continue;
    }
  }
  return found;
}

interface StopRequest {
  readonly directory: string;
  readonly folder: string;
  readonly signal: AbortSignal;
  readonly stopMilliseconds?: number;
}

type TreeRequest = Omit<StopRequest, "folder">;

type ScannedRequest = TreeRequest & {
  readonly scan: () => Promise<readonly TreeProcess[] | undefined>;
};

interface Cleanup {
  readonly stopped: readonly TreeProcess[];
  readonly remaining: readonly TreeProcess[] | undefined;
}

async function treeSnapshot(request: ScannedRequest) {
  const entries = await request.scan();
  return entries?.some((entry) => inTree(entry, request.directory)) === false
    ? request.scan()
    : entries;
}

async function waitForTree(request: ScannedRequest, deadline: number) {
  while (!request.signal.aborted) {
    const entries = await treeSnapshot(request);
    if (
      entries === undefined ||
      !entries.some((entry) => inTree(entry, request.directory)) ||
      performance.now() >= deadline
    )
      return entries;
    await delay(Math.min(250, Math.max(0, deadline - performance.now())));
  }
  return undefined;
}

export async function stopTreeProcesses(
  request: StopRequest,
): Promise<boolean> {
  const directory = await realpath(request.directory).catch(() => undefined);
  if (directory === undefined) return false;
  const canonical = { ...request, directory };
  const cleanup = await stopCanonicalTree({ ...canonical, scan: processes });
  return cleanup === undefined ? false : recordCleanup(canonical, cleanup);
}

export async function stopLeftProcesses(
  request: TreeRequest & {
    readonly seconds: number;
    readonly log: ((line: string) => void) | undefined;
  },
): Promise<void> {
  const directory = await realpath(request.directory).catch(() => undefined);
  if (directory === undefined) return;
  const calledAt = performance.now();
  const scan = () =>
    youngProcesses(
      request.seconds + Math.floor((performance.now() - calledAt) / 1000),
    );
  const found = await scan();
  if (found?.some((entry) => inTree(entry, directory)) !== true) return;
  const cleanup = await stopCanonicalTree({ ...request, directory, scan });
  for (const entry of distinct(cleanup?.stopped ?? []).values())
    request.log?.(
      `turn: stopped process ${String(entry.processId)} (${entry.command}) left in the work tree ${directory}\n`,
    );
}

async function stopCanonicalTree(
  request: ScannedRequest,
): Promise<Cleanup | undefined> {
  const entries = await treeSnapshot(request);
  const aborted = () => request.signal.aborted;
  if (entries === undefined || aborted()) return undefined;
  const stopped = terminate(entries, {
    directory: request.directory,
    signal: "SIGTERM",
  });
  let remaining =
    stopped.length === 0
      ? entries
      : await waitForTree(
          request,
          performance.now() + (request.stopMilliseconds ?? 15_000),
        );
  if (remaining === undefined || aborted()) return { stopped, remaining };
  const killed = terminate(remaining, {
    directory: request.directory,
    signal: "SIGKILL",
  });
  stopped.push(...killed);
  if (killed.length > 0)
    remaining = await waitForTree(request, performance.now() + 1000);
  return { stopped, remaining };
}

function distinct(
  entries: readonly TreeProcess[],
): ReadonlyMap<number, TreeProcess> {
  return new Map(entries.map((entry) => [entry.processId, entry]));
}

async function recordCleanup(
  request: StopRequest,
  cleanup: Cleanup,
): Promise<boolean> {
  const remainingProcessIds = cleanup.remaining
    ?.filter((entry) => inTree(entry, request.directory))
    .map((entry) => entry.processId);
  await writeRecord(request.folder, {
    name: "resume-processes.json",
    value: {
      processIds: [...distinct(cleanup.stopped).keys()],
      remainingProcessIds,
    },
  });
  return !request.signal.aborted && remainingProcessIds?.length === 0;
}
