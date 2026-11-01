import { constants, type Stats } from "node:fs";
import { lstat, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

const maximumBytes = 104_857_600;
const chunkBytes = 1_048_576;
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const webmSignature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

const signatures: ReadonlyMap<string, (head: Buffer) => boolean> = new Map([
  ["mp4", (head: Buffer) => head.subarray(4, 8).toString("latin1") === "ftyp"],
  ["webm", (head: Buffer) => head.subarray(0, 4).equals(webmSignature)],
  ["png", (head: Buffer) => head.subarray(0, 8).equals(pngSignature)],
]);

function listedStatus(path: string): Promise<Stats | undefined> {
  return lstat(path).catch(() => undefined);
}

async function realFolder(path: string): Promise<boolean> {
  const status = await listedStatus(path);
  return (
    status !== undefined && status.isDirectory() && !status.isSymbolicLink()
  );
}

async function realFolders(folder: string): Promise<boolean> {
  return (await realFolder(dirname(folder))) && (await realFolder(folder));
}

function sameFile(opened: Stats, listed: Stats | undefined): boolean {
  return (
    listed !== undefined &&
    listed.isFile() &&
    listed.ino === opened.ino &&
    listed.dev === opened.dev
  );
}

async function signed(handle: FileHandle, name: string): Promise<boolean> {
  const head = Buffer.alloc(8);
  const { bytesRead } = await handle.read(head, 0, 8, 0);
  const check = signatures.get(name.slice(name.lastIndexOf(".") + 1));
  return bytesRead === 8 && check !== undefined && check(head);
}

async function checkedHandle(
  handle: FileHandle,
  place: { readonly folder: string; readonly name: string },
): Promise<void> {
  const opened = await handle.stat();
  const listed = await listedStatus(join(place.folder, place.name));
  if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, listed))
    throw new Error("attachment-not-available");
  if (!(await realFolders(place.folder)))
    throw new Error("attachment-not-available");
  if (opened.size > maximumBytes) throw new Error("attachment-too-large");
  if (!(await signed(handle, place.name)))
    throw new Error("attachment-not-available");
}

export async function openedAttachment(place: {
  readonly folder: string;
  readonly name: string;
}): Promise<FileHandle> {
  if (!(await realFolders(place.folder)))
    throw new Error("attachment-not-available");
  const handle = await open(
    join(place.folder, place.name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined);
  if (handle === undefined) throw new Error("attachment-not-available");
  try {
    await checkedHandle(handle, place);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copiedChunks(
  source: FileHandle,
  target: FileHandle,
): Promise<void> {
  const chunk = Buffer.alloc(chunkBytes);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(chunk, 0, chunkBytes, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    if (position > maximumBytes) throw new Error("attachment-too-large");
    await target.write(chunk, 0, bytesRead);
  }
}

export async function copiedAttachment(
  handle: FileHandle,
  copy: string,
): Promise<void> {
  await rm(copy, { force: true });
  const target = await open(copy, "wx");
  try {
    await copiedChunks(handle, target);
  } finally {
    await target.close();
  }
}
