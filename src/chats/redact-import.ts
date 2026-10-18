import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPrivateFile, validateDestination } from "./destination.ts";
import { parseCorpus, validateCoverage } from "./corpus-input.ts";
import type { MessageRecord } from "./normalize.ts";
import {
  emptyCounts,
  redactRecord,
  categories,
  type RedactionSettings,
} from "./redaction.ts";

export interface RedactImportRequest {
  readonly importId: string;
  readonly workingDirectory: string;
  readonly runtimeDirectory: string | undefined;
  readonly settings: RedactionSettings;
}

async function readInput(path: string): Promise<string> {
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
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await handle.readFile(),
    );
  } finally {
    await handle.close();
  }
}

async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new Error("outputs-exist");
}

function redactCorpus(
  records: readonly MessageRecord[],
  settings: RedactionSettings,
) {
  const counts = emptyCounts();
  const lines: string[] = [];
  for (const record of records) {
    const result = redactRecord(record, settings);
    for (const category of categories)
      counts[category] += result.counts[category];
    lines.push(JSON.stringify(result.record) + "\n");
  }
  return {
    text: lines.join(""),
    summary: {
      counts,
      recordCount: records.length,
      totalCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
    },
  };
}

async function writeManifest(
  directory: string,
  manifest: object,
): Promise<void> {
  const path = join(directory, "redaction.json");
  let created = false;
  try {
    const handle = await createPrivateFile(path);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(manifest) + "\n");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) {
      await validateDestination(directory);
      await rm(path, { force: true });
    }
    throw error;
  }
}

export async function redactImport(request: RedactImportRequest) {
  const empty = {
    importId: request.importId,
    recordCount: 0,
    counts: emptyCounts(),
    totalCount: 0,
  };
  if (request.runtimeDirectory === undefined)
    return { ...empty, code: "runtime-directory-unknown" };
  try {
    if (
      process.platform !== "darwin" ||
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
        request.importId,
      )
    )
      throw new Error("invalid-import");
    const directory = resolve(
      request.workingDirectory,
      request.runtimeDirectory,
      "chats",
      request.importId,
    );
    await validateDestination(directory);
    if (!(await lstat(directory)).isDirectory())
      throw new Error("invalid-import");
    await absent(join(directory, "redacted.jsonl"));
    await absent(join(directory, "redaction.json"));
    validateCoverage(
      await readInput(join(directory, "coverage.json")),
      request.importId,
    );
    const result = redactCorpus(
      parseCorpus(await readInput(join(directory, "corpus.jsonl"))),
      request.settings,
    );
    const handle = await createPrivateFile(join(directory, "redacted.jsonl"));
    try {
      await handle.writeFile(result.text);
    } finally {
      await handle.close();
    }
    const { summary } = result;
    await writeManifest(directory, {
      schemaVersion: 1,
      importId: request.importId,
      ruleVersion: 1,
      ...summary,
    });
    return {
      code: "redaction-complete",
      importId: request.importId,
      ...summary,
    };
  } catch {
    return { ...empty, code: "redaction-failed" };
  }
}
