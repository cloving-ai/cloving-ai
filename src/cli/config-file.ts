import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { acquireSettingsLock, releaseSettingsLock } from "./config-lock.ts";
import {
  changedConfiguration,
  type SettingChange,
} from "../configuration-change.ts";

export async function readConfigFile(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

async function atomicWrite(
  path: string,
  contents: { readonly text: string; readonly mode?: number },
): Promise<void> {
  const { text, mode = 0o600 } = contents;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    if (mode !== 0o600) await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function changeConfigFile(
  path: string,
  change: SettingChange,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireSettingsLock(`${path}.lock`);
  try {
    await writeChange(path, change);
  } finally {
    await releaseSettingsLock(lock);
  }
}

async function writeChange(path: string, change: SettingChange): Promise<void> {
  const previous = await readConfigFile(path);
  const next = changedConfiguration(previous, change);
  const mode =
    previous !== undefined && change.scope === "project"
      ? (await stat(path)).mode & 0o777
      : 0o600;
  if (previous !== undefined && change.scope === "private")
    await chmod(path, 0o600);
  if (previous !== undefined)
    await atomicWrite(`${path}.bak`, { text: previous });
  await atomicWrite(path, { text: next, mode });
}
