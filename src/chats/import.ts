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
import {
  selectChatSources,
  type SelectionRequest,
  type SourceSelection,
} from "./selection.ts";

const corpusLimit = 52_428_800;

export interface ImportRequest extends SelectionRequest {
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
  readonly excluded?: number;
  readonly pending?: number;
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
): Promise<{
  roots: string[];
  files: CoverageEntry[];
  records: MessageRecord[];
}> {
  const selection = await selectChatSources(request);
  const files: CoverageEntry[] = [];
  const records: MessageRecord[] = [];
  let corpusBytes = 0;
  const corpus = await createPrivateFile(join(directory, "corpus.jsonl"));
  try {
    for (const selected of selection.entries) {
      const result = await readSelected(selected);
      files.push({
        ...result.coverage,
        kind: selected.kind,
        selection: selected.selection,
      });
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
  return { roots: selection.roots, files, records };
}

type CoverageEntry = Omit<SelectedTranscript, "status"> & {
  readonly status: SelectedTranscript["status"] | "excluded" | "pending";
  readonly kind: SourceSelection["kind"];
  readonly selection: SourceSelection["selection"];
};

async function readSelected(selected: SourceSelection) {
  if (selected.outcome !== undefined)
    return {
      coverage: {
        path: selected.path,
        ...selected.outcome,
        digest: null,
        recordCount: 0,
        omissions: { metadataRecords: 0, thinkingBlocks: 0 },
      },
      records: [],
    };
  return readTranscript(selected.path, selected.inspection);
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
  const empty = emptyImport(request);
  if (request.runtimeDirectory === undefined)
    return { ...empty, code: "runtime-directory-unknown" };
  try {
    const importId = randomUUID();
    const directory = await importDirectory(
      resolve(request.workingDirectory, request.runtimeDirectory),
      importId,
    );
    const { roots, files, records } = await writeImport(directory, request);
    const structure = structureImport(records);
    await writeStructure(directory, { importId, ...structure });
    const totals = importTotals(files);
    const { refused, pending } = totals;
    await writeCoverage(
      directory,
      coverageManifest({
        importId,
        roots,
        files,
        exclusions: request.excludeProjects ?? [],
      }),
    );
    return {
      code: refused + pending === 0 ? "import-complete" : "import-partial",
      importId,
      included: totals.included,
      refused,
      ...(roots.length === 0 ? {} : { excluded: totals.excluded, pending }),
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

function importTotals(files: readonly CoverageEntry[]) {
  return {
    included: files.filter((file) => file.status === "included").length,
    refused: files.filter((file) =>
      ["unreadable", "unsupported", "too-large"].includes(file.status),
    ).length,
    excluded: files.filter((file) => file.status === "excluded").length,
    pending: files.filter((file) => file.status === "pending").length,
  };
}

function coverageManifest(data: {
  readonly importId: string;
  readonly roots: readonly string[];
  readonly files: readonly CoverageEntry[];
  readonly exclusions: readonly string[];
}) {
  const { importId, roots, files, exclusions } = data;
  if (roots.length > 0)
    return {
      schemaVersion: 2,
      importId,
      roots,
      exclusions,
      limits: {
        depth: 4,
        files: 100,
        sourceBytes: 10_485_760,
        corpusBytes: corpusLimit,
      },
      entries: files,
    };
  return {
    schemaVersion: 1,
    importId,
    files: files.map((entry) => ({
      path: entry.path,
      status: entry.status,
      reason: entry.reason,
      digest: entry.digest,
      recordCount: entry.recordCount,
      omissions: entry.omissions,
    })),
  };
}

function emptyImport(request: ImportRequest) {
  return {
    importId: null,
    included: 0,
    refused: 0,
    ...((request.roots?.length ?? 0) === 0 ? {} : { excluded: 0, pending: 0 }),
    ...structureImport([]).counts,
  };
}
