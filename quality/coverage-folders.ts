import {
  existsSync,
  readFileSync,
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

export interface CoverageFolderPlace {
  readonly root: string;
  readonly now: () => number;
  readonly running: (processId: number) => boolean;
  readonly warn: (text: string) => void;
}

export function claimCoverageFolder(folder: string, processId: number): void {
  writeFileSync(`${folder}${ownerSuffix}`, `${String(processId)}\n`, {
    mode: 0o600,
  });
}

function removeOwnerFile(file: string): void {
  if (!existsSync(file)) return;
  unlinkSync(file);
}

export function releaseCoverageFolder(folder: string): void {
  try {
    rmSync(folder, { recursive: true, maxRetries: 3, retryDelay: 100 });
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

function ownerOf(folder: string): number | undefined {
  const file = `${folder}${ownerSuffix}`;
  if (!existsSync(file)) return undefined;
  const processId = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(processId) && processId > 0 ? processId : undefined;
}

function stale(folder: string, place: CoverageFolderPlace): boolean {
  const age = place.now() - statSync(folder).mtimeMs;
  if (age > maximumAgeMilliseconds) return true;
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

export function removeStaleCoverageFolders(place: CoverageFolderPlace): void {
  for (const name of readdirSync(place.root)) {
    if (!name.startsWith(folderPrefix)) continue;
    try {
      removeEntry(name, place);
    } catch (error) {
      place.warn(
        `coverage folder ${name} was not removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
