import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { writeRecord } from "./operation-journal.ts";
import { activeOwners, ownedProcesses, type TurnOwner } from "./turn-owners.ts";
import {
  inTree,
  keptLines,
  signalTargets,
  stoppable,
  type Snapshot,
  type TreeProcess,
} from "./worktree-selection.ts";

const execute = promisify(execFile);
const limits = {
  encoding: "utf8",
  timeout: 5000,
  maxBuffer: 8 * 1024 * 1024,
} as const;

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
  const text = await output("ps", [
    "-axo",
    "pid=,pgid=,uid=,ppid=,etime=,comm=",
  ]);
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const [
        processId = "0",
        group = "0",
        user = "-1",
        parent = "0",
        elapsed = "",
        ...command
      ] = line.trim().split(/\s+/);
      return {
        processId: Number(processId),
        group: Number(group),
        user: Number(user),
        parent: Number(parent),
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

export async function recordedProcessDirectory(
  processId: number,
): Promise<string | undefined> {
  return (await processes())?.find((entry) => entry.processId === processId)
    ?.directory;
}

function terminate(
  entries: readonly TreeProcess[],
  request: {
    readonly directory: string;
    readonly signal: NodeJS.Signals;
    readonly owners: readonly TurnOwner[];
  },
): TreeProcess[] {
  const { found, targets } = signalTargets(entries, {
    directory: request.directory,
    user: process.getuid?.(),
    owned: ownedProcesses(entries, request.owners),
  });
  for (const target of targets)
    try {
      process.kill(target, request.signal);
    } catch {
      continue;
    }
  return found;
}

interface StopRequest {
  readonly directory: string;
  readonly folder: string;
  readonly signal: AbortSignal;
  readonly stopMilliseconds?: number;
  readonly log?: ((line: string) => void) | undefined;
}

type TreeRequest = Omit<StopRequest, "folder">;

type ScannedRequest = TreeRequest & {
  readonly scan: () => Promise<Snapshot | undefined>;
};

interface Cleanup {
  readonly stopped: readonly TreeProcess[];
  readonly remaining: Snapshot | undefined;
}

function ownedScan(
  directory: string,
  scan: () => Promise<readonly TreeProcess[] | undefined>,
): () => Promise<Snapshot | undefined> {
  return async () => {
    const entries = await scan();
    return entries === undefined
      ? undefined
      : { entries, owners: await activeOwners(directory) };
  };
}

async function treeSnapshot(request: ScannedRequest) {
  const snapshot = await request.scan();
  return snapshot !== undefined &&
    stoppable(snapshot, request.directory).length === 0
    ? request.scan()
    : snapshot;
}

async function waitForTree(request: ScannedRequest, deadline: number) {
  while (!request.signal.aborted) {
    const snapshot = await treeSnapshot(request);
    if (
      snapshot === undefined ||
      stoppable(snapshot, request.directory).length === 0 ||
      performance.now() >= deadline
    )
      return snapshot;
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
  const scan = ownedScan(directory, processes);
  const cleanup = await stopCanonicalTree({ ...canonical, scan });
  return cleanup === undefined ? false : recordCleanup(canonical, cleanup);
}

export async function stopLeftProcesses(
  request: TreeRequest & {
    readonly seconds: number;
    readonly runId: string;
  },
): Promise<void> {
  const directory = await realpath(request.directory).catch(() => undefined);
  if (directory === undefined) return;
  const calledAt = performance.now();
  const young = () =>
    youngProcesses(
      request.seconds + Math.floor((performance.now() - calledAt) / 1000),
    );
  const found = await young();
  if (found?.some((entry) => inTree(entry, directory)) !== true) return;
  const scan = ownedScan(directory, young);
  const cleanup = await stopCanonicalTree({ ...request, directory, scan });
  for (const entry of distinct(cleanup?.stopped ?? []).values())
    request.log?.(
      `turn: stopped process ${String(entry.processId)} (${entry.command}) that run ${request.runId} left in the work tree ${directory}\n`,
    );
}

function signalled(
  snapshot: Snapshot,
  request: ScannedRequest & {
    readonly logged: Set<number>;
    readonly stopSignal: NodeJS.Signals;
  },
): TreeProcess[] {
  for (const line of keptLines(snapshot, {
    directory: request.directory,
    user: process.getuid?.(),
    logged: request.logged,
  }))
    request.log?.(line);
  return terminate(snapshot.entries, {
    directory: request.directory,
    signal: request.stopSignal,
    owners: snapshot.owners,
  });
}

async function stopCanonicalTree(
  request: ScannedRequest,
): Promise<Cleanup | undefined> {
  const snapshot = await treeSnapshot(request);
  const aborted = () => request.signal.aborted;
  if (snapshot === undefined || aborted()) return undefined;
  const logged = new Set<number>();
  const stopped = signalled(snapshot, {
    ...request,
    logged,
    stopSignal: "SIGTERM",
  });
  let remaining =
    stopped.length === 0
      ? snapshot
      : await waitForTree(
          request,
          performance.now() + (request.stopMilliseconds ?? 15_000),
        );
  if (remaining === undefined || aborted()) return { stopped, remaining };
  const killed = signalled(remaining, {
    ...request,
    logged,
    stopSignal: "SIGKILL",
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
  const remainingProcessIds =
    cleanup.remaining === undefined
      ? undefined
      : stoppable(cleanup.remaining, request.directory).map(
          (entry) => entry.processId,
        );
  await writeRecord(request.folder, {
    name: "resume-processes.json",
    value: {
      processIds: [...distinct(cleanup.stopped).keys()],
      remainingProcessIds,
    },
  });
  return !request.signal.aborted && remainingProcessIds?.length === 0;
}
