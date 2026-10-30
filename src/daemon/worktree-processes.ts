import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { writeRecord } from "./operation-journal.ts";

const execute = promisify(execFile);

interface TreeProcess {
  readonly processId: number;
  readonly group: number;
  readonly user: number;
  readonly directory?: string;
}

async function output(command: string, arguments_: readonly string[]) {
  return (
    await execute(command, arguments_, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout;
}

async function directories(): Promise<ReadonlyMap<number, string>> {
  if (process.platform === "linux") {
    const entries = await readdir("/proc");
    const links = await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
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
  const text = await output("lsof", ["-d", "cwd", "-Fpn", "-n", "-P"]);
  const found = new Map<number, string>();
  let processId = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) processId = Number(line.slice(1));
    if (line.startsWith("n")) found.set(processId, line.slice(1));
  }
  return found;
}

async function processes(): Promise<readonly TreeProcess[] | undefined> {
  try {
    const text = await output("ps", ["-axo", "pid=,pgid=,uid="]);
    const entries = text
      .trim()
      .split("\n")
      .map((line) => {
        const [processId = 0, group = 0, user = -1] = line
          .trim()
          .split(/\s+/)
          .map(Number);
        return { processId, group, user };
      });
    const working = await directories();
    return entries.map((entry) => {
      const directory = working.get(entry.processId);
      return { ...entry, ...(directory === undefined ? {} : { directory }) };
    });
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
): number[] {
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
  return found.map((entry) => entry.processId);
}

interface StopRequest {
  readonly directory: string;
  readonly folder: string;
  readonly signal: AbortSignal;
  readonly stopMilliseconds?: number;
}

async function treeSnapshot(directory: string) {
  const entries = await processes();
  return entries?.some((entry) => inTree(entry, directory)) === false
    ? processes()
    : entries;
}

async function waitForTree(request: StopRequest, deadline: number) {
  while (!request.signal.aborted) {
    const entries = await treeSnapshot(request.directory);
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
  return directory === undefined
    ? false
    : stopCanonicalTree({ ...request, directory });
}

async function stopCanonicalTree(request: StopRequest): Promise<boolean> {
  const entries = await treeSnapshot(request.directory);
  const aborted = () => request.signal.aborted;
  if (entries === undefined || aborted()) return false;
  const processIds = terminate(entries, {
    directory: request.directory,
    signal: "SIGTERM",
  });
  let remaining =
    processIds.length === 0
      ? entries
      : await waitForTree(
          request,
          performance.now() + (request.stopMilliseconds ?? 15_000),
        );
  if (remaining === undefined || aborted())
    return recordCleanup(request, { processIds, remaining });
  const killed = terminate(remaining, {
    directory: request.directory,
    signal: "SIGKILL",
  });
  processIds.push(...killed);
  if (killed.length > 0)
    remaining = await waitForTree(request, performance.now() + 1000);
  return recordCleanup(request, { processIds, remaining });
}

async function recordCleanup(
  request: StopRequest,
  cleanup: {
    readonly processIds: readonly number[];
    readonly remaining: readonly TreeProcess[] | undefined;
  },
): Promise<boolean> {
  const remainingProcessIds = cleanup.remaining
    ?.filter((entry) => inTree(entry, request.directory))
    .map((entry) => entry.processId);
  await writeRecord(request.folder, {
    name: "resume-processes.json",
    value: {
      processIds: [...new Set(cleanup.processIds)],
      remainingProcessIds,
    },
  });
  return !request.signal.aborted && remainingProcessIds?.length === 0;
}
