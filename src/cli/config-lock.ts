import { randomUUID } from "node:crypto";
import { readlink, symlink, unlink } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

interface Lock {
  readonly path: string;
  readonly owner: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function owner(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function stopped(value: string): boolean {
  const [pid] = value.split("-");
  if (pid === undefined || !/^[1-9][0-9]*$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}

export async function releaseSettingsLock(lock: Lock): Promise<void> {
  if ((await owner(lock.path)) === lock.owner) await unlink(lock.path);
}

async function reclaim(
  path: string,
  input: { readonly previous: string; readonly deadline: number },
): Promise<void> {
  const guard = await acquireSettingsLock(`${path}.reap`, input.deadline);
  try {
    if ((await owner(path)) === input.previous) await unlink(path);
  } finally {
    await releaseSettingsLock(guard);
  }
}

export async function acquireSettingsLock(
  path: string,
  deadline = Date.now() + 10000,
): Promise<Lock> {
  const lock = { path, owner: `${String(process.pid)}-${randomUUID()}` };
  while (Date.now() < deadline) {
    try {
      await symlink(lock.owner, path);
      return lock;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const previous = await owner(path);
    if (previous !== undefined && stopped(previous))
      await reclaim(path, { previous, deadline });
    else await setTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw new Error("settings-locked");
}
