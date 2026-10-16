import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonical(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
  return realpath(path);
}

async function outsideRepository(path: string): Promise<void> {
  let ancestor = path;
  for (;;) {
    try {
      await lstat(join(ancestor, ".git"));
      throw new Error("destination-refused");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

async function privateDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) throw new Error("destination-refused");
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await privateDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 });
}

export async function importDirectory(
  runtime: string,
  importId: string,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("destination-refused");
  let chats: string;
  try {
    chats = await canonical(join(resolve(runtime), "chats"));
    await outsideRepository(chats);
  } catch {
    throw new Error("destination-refused");
  }
  await privateDirectory(chats);
  await validateDestination(chats);
  const directory = join(chats, importId);
  await mkdir(directory, { mode: 0o700 });
  await validateDestination(directory);
  return directory;
}

export async function validateDestination(directory: string): Promise<void> {
  if ((await realpath(directory)) !== directory)
    throw new Error("destination-refused");
  await outsideRepository(directory);
}

export async function createPrivateFile(path: string): Promise<FileHandle> {
  await validateDestination(dirname(path));
  const darwinNoFollowAny = 0x20000000;
  try {
    return await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        darwinNoFollowAny,
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP")
      throw new Error("destination-refused", { cause: error });
    throw error;
  }
}
