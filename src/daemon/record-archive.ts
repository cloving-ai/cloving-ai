import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export interface RecordFiles {
  readonly move: (source: string, target: string) => Promise<void>;
  readonly copy: (source: string, target: string) => Promise<void>;
}

export interface StoredFile {
  readonly path: string;
  readonly size: number;
  readonly changedAt: number;
}

export const nodeFiles: RecordFiles = {
  move: rename,
  copy: (source, target) =>
    cp(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    }),
};

export function failureReason(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return error instanceof Error ? error.message : String(error);
}

export async function storedFiles(folder: string): Promise<StoredFile[]> {
  const found: StoredFile[] = [];
  for (const entry of await readdir(folder, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const file = await lstat(path);
    found.push({
      path: relative(folder, path),
      size: file.size,
      changedAt: file.mtimeMs,
    });
  }
  return found;
}

export async function archiveReady(
  folder: string,
  settings: { readonly configured: boolean },
): Promise<string | undefined> {
  try {
    if (!settings.configured) await mkdir(folder, { recursive: true });
    if (!(await stat(folder)).isDirectory()) return "not-a-folder";
    await access(folder, constants.W_OK);
    return undefined;
  } catch (error) {
    return failureReason(error);
  }
}

async function sameFiles(source: string, copy: string): Promise<boolean> {
  const listed = async (folder: string): Promise<string> =>
    JSON.stringify(
      (await storedFiles(folder)).map((file) => [file.path, file.size]).sort(),
    );
  return (await listed(source)) === (await listed(copy));
}

async function copied(
  place: { readonly source: string; readonly target: string },
  files: RecordFiles,
): Promise<void> {
  const staged = `${place.target}.staged`;
  await rm(staged, { recursive: true, force: true });
  try {
    await files.copy(place.source, staged);
    if (!(await sameFiles(place.source, staged)))
      throw new Error("archive-copy-incomplete");
    await rename(staged, place.target);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  await rm(place.source, { recursive: true, force: true });
}

export async function archivedFolder(
  place: { readonly source: string; readonly target: string },
  files: RecordFiles,
): Promise<void> {
  await mkdir(dirname(place.target), { recursive: true });
  try {
    await files.move(place.source, place.target);
    return;
  } catch (error) {
    if (failureReason(error) !== "EXDEV") throw error;
  }
  await copied(place, files);
}
