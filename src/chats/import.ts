import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createPrivateFile,
  importDirectory,
  validateDestination,
} from "./destination.ts";
import { readTranscript, type SelectedTranscript } from "./reader.ts";

export interface ImportRequest {
  readonly paths: readonly string[];
  readonly workingDirectory: string;
  readonly runtimeDirectory: string | undefined;
}

export interface ImportSummary {
  readonly code:
    | "import-complete"
    | "import-partial"
    | "runtime-directory-unknown"
    | "destination-refused"
    | "output-failed";
  readonly importId: string | null;
  readonly included: number;
  readonly refused: number;
  readonly records: number;
}

async function writeImport(
  directory: string,
  request: ImportRequest,
): Promise<SelectedTranscript[]> {
  const files: SelectedTranscript[] = [];
  const corpus = await createPrivateFile(join(directory, "corpus.jsonl"));
  try {
    for (const selected of request.paths) {
      const result = await readTranscript(
        resolve(request.workingDirectory, selected),
      );
      files.push(result.coverage);
      for (const record of result.records)
        await corpus.writeFile(`${JSON.stringify(record)}\n`);
    }
  } finally {
    await corpus.close();
  }
  return files;
}

async function writeCoverage(
  directory: string,
  coverage: object,
): Promise<void> {
  const manifest = join(directory, "coverage.json");
  let created = false;
  try {
    const handle = await createPrivateFile(manifest);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(coverage, null, 2)}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) {
      await validateDestination(directory);
      await rm(manifest, { force: true });
    }
    throw error;
  }
}

export async function importChats(
  request: ImportRequest,
): Promise<ImportSummary> {
  const empty = { importId: null, included: 0, refused: 0, records: 0 };
  if (request.runtimeDirectory === undefined)
    return { ...empty, code: "runtime-directory-unknown" };
  try {
    const importId = randomUUID();
    const directory = await importDirectory(
      resolve(request.workingDirectory, request.runtimeDirectory),
      importId,
    );
    const files = await writeImport(directory, request);
    const included = files.filter((file) => file.status === "included").length;
    const records = files.reduce((count, file) => count + file.recordCount, 0);
    const refused = files.length - included;
    await writeCoverage(directory, { schemaVersion: 1, importId, files });
    return {
      code: refused === 0 ? "import-complete" : "import-partial",
      importId,
      included,
      refused,
      records,
    };
  } catch (error) {
    return {
      ...empty,
      code:
        error instanceof Error && error.message === "destination-refused"
          ? "destination-refused"
          : "output-failed",
    };
  }
}
