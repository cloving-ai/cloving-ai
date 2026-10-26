import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const folderPrefix = "cloving-test-coverage-";
const ownerSuffix = ".owner";
const maximumAgeMilliseconds = 6 * 60 * 60 * 1000;
const maximumOwnerBytes = 32;

export interface CoverageFolderPlace {
  readonly root: string;
  readonly now: () => number;
  readonly running: (processId: number) => boolean;
  readonly warn: (text: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function claimCoverageFolder(folder: string, processId: number): void {
  writeFileSync(`${folder}${ownerSuffix}`, `${String(processId)}\n`, {
    mode: 0o600,
  });
}

function removeOwnerFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
  }
}

export function releaseCoverageFolder(folder: string): void {
  try {
    rmSync(folder, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } finally {
    removeOwnerFile(`${folder}${ownerSuffix}`);
  }
}

export function processRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

function openOwnerFile(file: string): number | undefined {
  try {
    return openSync(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    return undefined;
  }
}

function ownerProcess(descriptor: number): number | undefined {
  if (!fstatSync(descriptor).isFile()) return undefined;
  const buffer = Buffer.alloc(maximumOwnerBytes);
  const length = readSync(descriptor, buffer, 0, maximumOwnerBytes, 0);
  const processId = Number(buffer.subarray(0, length).toString("utf8").trim());
  return Number.isInteger(processId) && processId > 0 ? processId : undefined;
}

function ownerOf(folder: string): number | undefined {
  const descriptor = openOwnerFile(`${folder}${ownerSuffix}`);
  if (descriptor === undefined) return undefined;
  try {
    return ownerProcess(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function stale(folder: string, place: CoverageFolderPlace): boolean {
  const entry = statSync(folder, { throwIfNoEntry: false });
  if (entry === undefined) return false;
  if (place.now() - entry.mtimeMs > maximumAgeMilliseconds) return true;
  const owner = ownerOf(folder);
  return owner !== undefined && !place.running(owner);
}

function removeLeftOwnerFile(path: string): void {
  if (existsSync(path.slice(0, -ownerSuffix.length))) return;
  removeOwnerFile(path);
}

function removeEntry(name: string, place: CoverageFolderPlace): void {
  const path = join(place.root, name);
  if (name.endsWith(ownerSuffix)) {
    removeLeftOwnerFile(path);
    return;
  }
  if (stale(path, place)) releaseCoverageFolder(path);
}

function entries(place: CoverageFolderPlace): readonly string[] {
  try {
    return readdirSync(place.root);
  } catch (error) {
    place.warn(
      `coverage folders in ${place.root} were not listed: ${errorText(error)}`,
    );
    return [];
  }
}

export function removeStaleCoverageFolders(place: CoverageFolderPlace): void {
  for (const name of entries(place)) {
    if (!name.startsWith(folderPrefix)) continue;
    try {
      removeEntry(name, place);
    } catch (error) {
      place.warn(
        `coverage folder ${name} was not removed: ${errorText(error)}`,
      );
    }
  }
}
