import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { validateDestination } from "./destination.ts";
import { readInput } from "./input-file.ts";
import {
  parseEvidenceCoverage,
  nextEvidenceRevision,
} from "./revision-input.ts";

async function optionalRevision(path: string): Promise<string | undefined> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  return readInput(path);
}

export async function readPreviousImport(runtime: string, importId: string) {
  try {
    if (
      process.platform !== "darwin" ||
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
        importId,
      )
    )
      throw new Error("invalid-import");
    const directory = join(runtime, "chats", importId);
    await validateDestination(directory);
    if (!(await lstat(directory)).isDirectory())
      throw new Error("invalid-import");
    const entries = parseEvidenceCoverage(
      await readInput(join(directory, "coverage.json")),
      importId,
    );
    const evidenceRevision = nextEvidenceRevision(
      await optionalRevision(join(directory, "revision.json")),
      importId,
    );
    return { importId, entries, evidenceRevision };
  } catch {
    throw new Error("previous-import-refused");
  }
}
