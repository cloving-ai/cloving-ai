import { openInput, readInput } from "./input-file.ts";
import { lstat, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPrivateFile, validateDestination } from "./destination.ts";
import { parseCorpusRecord, validateCoverage } from "./corpus-input.ts";
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

async function* corpusLines(handle: FileHandle): AsyncGenerator<string> {
  const buffer = Buffer.alloc(65_536);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = "";
  let bytesRead = -1;
  while (bytesRead !== 0) {
    ({ bytesRead } = await handle.read({ buffer, position: null }));
    pending += decoder.decode(buffer.subarray(0, bytesRead), {
      stream: bytesRead !== 0,
    });
    let start = 0;
    let end = pending.indexOf("\n");
    while (end !== -1) {
      yield pending.slice(start, end);
      start = end + 1;
      end = pending.indexOf("\n", start);
    }
    pending = pending.slice(start);
  }
  if (pending !== "") yield pending;
}

async function redactCorpus(
  handles: { readonly input: FileHandle; readonly output: FileHandle },
  settings: RedactionSettings,
) {
  const counts = emptyCounts();
  let recordCount = 0;
  for await (const line of corpusLines(handles.input)) {
    const result = redactRecord(parseCorpusRecord(line), settings);
    for (const category of categories)
      counts[category] += result.counts[category];
    await handles.output.writeFile(JSON.stringify(result.record) + "\n");
    recordCount++;
  }
  return {
    counts,
    recordCount,
    totalCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

async function writeRedactedCorpus(
  directory: string,
  settings: RedactionSettings,
) {
  const path = join(directory, "redacted.jsonl");
  let created = false;
  try {
    const input = await openInput(join(directory, "corpus.jsonl"));
    try {
      const output = await createPrivateFile(path);
      created = true;
      try {
        return await redactCorpus({ input, output }, settings);
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  } catch (error) {
    if (created) {
      await validateDestination(directory);
      await rm(path, { force: true });
    }
    throw error;
  }
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
  if (process.platform !== "darwin")
    return { ...empty, code: "platform-unsupported" };
  if (request.runtimeDirectory === undefined)
    return { ...empty, code: "runtime-directory-unknown" };
  try {
    if (
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
    const summary = await writeRedactedCorpus(directory, request.settings);
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
