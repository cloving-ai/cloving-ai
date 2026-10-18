import type { MessageRecord } from "./normalize.ts";
import {
  structureImport,
  type ImportStructure,
  type StructureCounts,
} from "./structure.ts";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createPrivateFile,
  importDirectory,
  validateDestination,
} from "./destination.ts";
import { readTranscript, type SelectedTranscript } from "./reader.ts";

const corpusLimit = 52_428_800;

export interface ImportRequest {
  readonly paths: readonly string[];
  readonly workingDirectory: string;
  readonly runtimeDirectory: string | undefined;
}

export interface ImportSummary extends StructureCounts {
  readonly code:
    | "import-complete"
    | "import-partial"
    | "runtime-directory-unknown"
    | "destination-refused"
    | "output-failed";
  readonly importId: string | null;
  readonly included: number;
  readonly refused: number;
}

function boundedCorpusLine(record: MessageRecord, previousBytes: number) {
  const line = `${JSON.stringify(record)}\n`;
  const bytes = previousBytes + Buffer.byteLength(line);
  if (bytes > corpusLimit) throw new Error("corpus-too-large");
  return { line, bytes };
}

async function writeImport(
  directory: string,
  request: ImportRequest,
): Promise<{ files: SelectedTranscript[]; records: MessageRecord[] }> {
  const files: SelectedTranscript[] = [];
  const records: MessageRecord[] = [];
  let corpusBytes = 0;
  const corpus = await createPrivateFile(join(directory, "corpus.jsonl"));
  try {
    for (const selected of request.paths) {
      const result = await readTranscript(
        resolve(request.workingDirectory, selected),
      );
      files.push(result.coverage);
      for (const record of result.records) {
        const next = boundedCorpusLine(record, corpusBytes);
        await corpus.writeFile(next.line);
        corpusBytes = next.bytes;
        records.push(record);
      }
    }
  } finally {
    await corpus.close();
  }
  return { files, records };
}

async function writeStructure(
  directory: string,
  data: ImportStructure & { readonly importId: string },
): Promise<void> {
  const handle = await createPrivateFile(join(directory, "structure.json"));
  try {
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, ...data }, null, 2)}\n`,
    );
  } finally {
    await handle.close();
  }
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
  const empty = {
    importId: null,
    included: 0,
    refused: 0,
    ...structureImport([]).counts,
  };
  if (request.runtimeDirectory === undefined)
    return { ...empty, code: "runtime-directory-unknown" };
  try {
    const importId = randomUUID();
    const directory = await importDirectory(
      resolve(request.workingDirectory, request.runtimeDirectory),
      importId,
    );
    const { files, records } = await writeImport(directory, request);
    const structure = structureImport(records);
    await writeStructure(directory, { importId, ...structure });
    const included = files.filter((file) => file.status === "included").length;
    const refused = files.length - included;
    await writeCoverage(directory, { schemaVersion: 1, importId, files });
    return {
      code: refused === 0 ? "import-complete" : "import-partial",
      importId,
      included,
      refused,
      ...structure.counts,
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
