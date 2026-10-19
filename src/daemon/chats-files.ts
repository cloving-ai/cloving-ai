import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { openInput } from "../chats/input-file.ts";
import {
  createPrivateFile,
  validateDestination,
} from "../chats/destination.ts";
import {
  analysisDocumentBytes,
  type AnalysisSnapshot,
} from "../chats/analysis-input.ts";

export async function analysisDirectory(
  runtime: string,
  importId: string,
): Promise<string> {
  if (process.platform !== "darwin") throw new Error("platform-unsupported");
  const directory = resolve(runtime, "chats", importId);
  await checkedDirectory(directory);
  return directory;
}

async function checkedDirectory(directory: string): Promise<void> {
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error("analysis-input-refused");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
    const parent = dirname(directory);
    if (parent === directory) throw error;
    await checkedDirectory(parent);
    throw error;
  }
  await validateDestination(directory);
}

export async function boundedAnalysisFile(
  path: string,
  options: { readonly permissions?: number } = {},
): Promise<string> {
  const handle = await openInput(path);
  try {
    if (
      options.permissions !== undefined &&
      ((await handle.stat()).mode & 0o777) !== options.permissions
    )
      throw new Error("analysis-output-failed");
    const buffer = Buffer.alloc(analysisDocumentBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > analysisDocumentBytes) throw new Error("analysis-too-large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, size),
    );
  } finally {
    await handle.close();
  }
}

export async function readAnalysisSnapshot(
  directory: string,
  importId: string,
): Promise<AnalysisSnapshot> {
  const required = async (name: string): Promise<string> => {
    try {
      return await boundedAnalysisFile(join(directory, name));
    } catch (error) {
      if (Reflect.get(Object(error), "code") === "ENOENT")
        throw new Error("redaction-required", { cause: error });
      throw error;
    }
  };
  return {
    importId,
    redaction: await required("redaction.json"),
    corpus: await required("redacted.jsonl"),
    structure: await boundedAnalysisFile(join(directory, "structure.json")),
  };
}

export async function matchingPrivateFile(
  path: string,
  text: string,
): Promise<void> {
  try {
    const existing = await boundedAnalysisFile(path, { permissions: 0o600 });
    if (existing !== text) throw new Error("analysis-output-failed");
    return;
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
  }
  const handle = await createPrivateFile(path);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

interface AnalysisOutput {
  readonly cycleId: string;
  readonly analysis: string;
  readonly proposal: string;
}

export async function inspectAnalysisFiles(
  directory: string,
  output: AnalysisOutput,
): Promise<"complete" | "absent"> {
  const proposal = join(directory, `proposal-${output.cycleId}.txt`);
  const analysis = join(directory, `analysis-${output.cycleId}.json`);
  const marker = await boundedAnalysisFile(analysis, {
    permissions: 0o600,
  }).catch((error: unknown) => {
    if (Reflect.get(Object(error), "code") === "ENOENT") return undefined;
    throw error;
  });
  if (marker === undefined) return "absent";
  if (
    marker !== output.analysis ||
    (await boundedAnalysisFile(proposal, { permissions: 0o600 })) !==
      output.proposal
  )
    throw new Error("analysis-output-failed");
  return "complete";
}

export async function saveAnalysisFiles(
  directory: string,
  output: AnalysisOutput,
): Promise<void> {
  if ((await inspectAnalysisFiles(directory, output)) === "complete") return;
  const proposal = join(directory, `proposal-${output.cycleId}.txt`);
  const analysis = join(directory, `analysis-${output.cycleId}.json`);
  await matchingPrivateFile(proposal, output.proposal);
  await matchingPrivateFile(analysis, output.analysis);
}
