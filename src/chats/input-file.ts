import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export async function openInput(path: string): Promise<FileHandle> {
  if (process.platform !== "darwin") throw new Error("platform-unsupported");
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("invalid-import");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("invalid-import");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readInput(path: string): Promise<string> {
  const handle = await openInput(path);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await handle.readFile(),
    );
  } finally {
    await handle.close();
  }
}
