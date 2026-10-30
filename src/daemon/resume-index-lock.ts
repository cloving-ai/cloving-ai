import { execFile } from "node:child_process";
import { lstat, readdir, readFile, stat, unlink } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

function disappeared(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ESRCH")
  );
}

async function descriptorUsesLock(
  path: string,
  lock: { readonly dev: number; readonly ino: number },
): Promise<boolean | undefined> {
  try {
    const opened = await stat(path);
    if (opened.dev !== lock.dev || opened.ino !== lock.ino) return false;
    const information = await readFile(
      path.replace("/fd/", "/fdinfo/"),
      "utf8",
    );
    const flags = /^flags:\s+([0-7]+)$/m.exec(information)?.[1];
    const inode = /^ino:\s+(\d+)$/m.exec(information)?.[1];
    if (flags === undefined || Number(inode) !== lock.ino) return undefined;
    return (Number.parseInt(flags, 8) & 3) !== 0;
  } catch (error) {
    return disappeared(error) ? false : undefined;
  }
}

async function processUsesLock(
  directory: string,
  lock: { readonly dev: number; readonly ino: number },
): Promise<boolean | undefined> {
  try {
    for (const descriptor of await readdir(directory)) {
      const used = await descriptorUsesLock(`${directory}/${descriptor}`, lock);
      if (used !== false) return used;
    }
    return false;
  } catch (error) {
    return disappeared(error) ? false : undefined;
  }
}

interface LockIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly mtimeMs: number;
}

export interface OwnedIndexLock extends LockIdentity {
  readonly processIds: readonly number[];
}

async function lockOwners(
  lock: LockIdentity,
): Promise<readonly number[] | undefined> {
  if (process.platform === "linux") {
    const processIds: number[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const used = await processUsesLock(`/proc/${entry}/fd`, lock);
      if (used === undefined) return undefined;
      if (used) processIds.push(Number(entry));
    }
    return processIds;
  }
  try {
    const { stdout, stderr } = await execute(
      "lsof",
      ["-Fpfa", "--", lock.path],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return stderr === "" ? writableOwners(stdout) : undefined;
  } catch {
    return undefined;
  }
}

function writableOwner(record: string): number | null | undefined {
  const [header, ...descriptors] = record.trim().split(/^f/m);
  const processId = Number(header?.trim().slice(1));
  const access = descriptors.map((descriptor) => descriptor.split("\n")[1]);
  if (
    !Number.isSafeInteger(processId) ||
    processId < 1 ||
    descriptors.length === 0 ||
    access.some((mode) => mode !== "ar" && mode !== "aw" && mode !== "au")
  )
    return undefined;
  return access.some((mode) => mode === "aw" || mode === "au")
    ? processId
    : null;
}

function writableOwners(text: string): readonly number[] | undefined {
  const owners = text
    .trim()
    .split(/(?=^p)/m)
    .map(writableOwner);
  return owners.includes(undefined)
    ? undefined
    : [
        ...new Set(
          owners.filter((owner): owner is number => typeof owner === "number"),
        ),
      ];
}

export async function ownedIndexLock(
  path: string,
): Promise<OwnedIndexLock | undefined> {
  try {
    const identity = await lstat(path);
    if (!identity.isFile()) return undefined;
    const lock = {
      path,
      dev: identity.dev,
      ino: identity.ino,
      ctimeMs: identity.ctimeMs,
      mtimeMs: identity.mtimeMs,
    };
    const processIds = await lockOwners(lock);
    return processIds === undefined || processIds.length === 0
      ? undefined
      : { ...lock, processIds };
  } catch {
    return undefined;
  }
}

function stopped(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export async function removeStoppedIndexLock(
  lock: OwnedIndexLock,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    if (!lock.processIds.every(stopped)) return false;
    const after = await lstat(lock.path);
    if (
      signal.aborted ||
      lock.dev !== after.dev ||
      lock.ino !== after.ino ||
      lock.ctimeMs !== after.ctimeMs ||
      lock.mtimeMs !== after.mtimeMs
    )
      return false;
    await unlink(lock.path);
    return true;
  } catch {
    return false;
  }
}
