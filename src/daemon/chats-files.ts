import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { record } from "../protocol.ts";
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

export interface AnalysisOutput {
  readonly cycleId: string;
  readonly analysis: string;
  readonly proposal: string;
  readonly draft?: AnalysisDraftInput;
}

async function requireAbsent(directory: string, names: readonly string[]) {
  for (const name of names) {
    const exists = await lstat(join(directory, name)).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      },
    );
    if (exists !== undefined) throw new Error("analysis-output-failed");
  }
}

function outputClaim(
  directory: string,
  output: AnalysisOutput | AnalysisDraftInput,
) {
  return {
    path: join(
      directory,
      `${"draft" in output ? "final-claim" : "claim"}-${output.cycleId}.json`,
    ),
    text:
      JSON.stringify({
        schemaVersion: 1,
        kind: "reply" in output ? "draft" : "final",
        digest: createHash("sha256")
          .update(JSON.stringify(output))
          .digest("hex"),
      }) + "\n",
  };
}

async function inspectOutputClaim(claim: {
  readonly path: string;
  readonly text: string;
}) {
  const text = await boundedAnalysisFile(claim.path, {
    permissions: 0o600,
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text !== undefined && text !== claim.text)
    throw new Error("analysis-output-failed");
}

export async function inspectAnalysisFiles(
  directory: string,
  output: AnalysisOutput,
): Promise<"complete" | "absent"> {
  await inspectOutputClaim(outputClaim(directory, output));
  if (output.draft === undefined)
    await requireAbsent(directory, [`draft-${output.cycleId}.json`]);
  else if (
    (await inspectAnalysisDraftRecord(directory, output.draft)) === undefined
  )
    throw new Error("analysis-output-failed");
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
  const claim = outputClaim(directory, output);
  await matchingPrivateFile(claim.path, claim.text);
  const proposal = join(directory, `proposal-${output.cycleId}.txt`);
  const analysis = join(directory, `analysis-${output.cycleId}.json`);
  await matchingPrivateFile(proposal, output.proposal);
  await matchingPrivateFile(analysis, output.analysis);
}

export interface AnalysisDraftInput {
  readonly runId: string;
  readonly cycleId: string;
  readonly operationId: string;
  readonly inputDigest: string;
  readonly snapshotDigest: string;
  readonly reply: string;
}

interface AnalysisDraftMetadata {
  readonly candidateDigest: string;
  readonly expiresAt: string;
}

function draftRecord(input: AnalysisDraftInput, expiresAt: string) {
  return {
    schemaVersion: 1,
    ...input,
    candidateDigest: createHash("sha256").update(input.reply).digest("hex"),
    expiresAt,
  };
}

export async function inspectAnalysisDraft(
  directory: string,
  input: AnalysisDraftInput,
): Promise<AnalysisDraftMetadata | undefined> {
  await requireAbsent(directory, [
    `analysis-${input.cycleId}.json`,
    `proposal-${input.cycleId}.txt`,
  ]);
  return inspectAnalysisDraftRecord(directory, input);
}

export async function inspectAnalysisDraftRecord(
  directory: string,
  input: AnalysisDraftInput,
): Promise<AnalysisDraftMetadata | undefined> {
  await inspectOutputClaim(outputClaim(directory, input));
  const text = await boundedAnalysisFile(
    join(directory, `draft-${input.cycleId}.json`),
    { permissions: 0o600 },
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const expiresAt = record(JSON.parse(text))?.["expiresAt"];
  if (
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt
  )
    throw new Error("analysis-output-failed");
  const expected = draftRecord(input, expiresAt);
  if (text !== JSON.stringify(expected) + "\n")
    throw new Error("analysis-output-failed");
  return { candidateDigest: expected.candidateDigest, expiresAt };
}

export async function saveAnalysisDraft(
  directory: string,
  saving: { readonly input: AnalysisDraftInput; readonly now: () => string },
): Promise<AnalysisDraftMetadata> {
  const { input, now } = saving;
  const existing = await inspectAnalysisDraft(directory, input);
  if (existing !== undefined) return existing;
  const claim = outputClaim(directory, input);
  await matchingPrivateFile(claim.path, claim.text);
  const expiresAt = new Date(Date.parse(now()) + 86_400_000).toISOString();
  const draft = draftRecord(input, expiresAt);
  const text = JSON.stringify(draft) + "\n";
  if (Buffer.byteLength(text) > analysisDocumentBytes)
    throw new Error("analysis-output-failed");
  await matchingPrivateFile(
    join(directory, `draft-${input.cycleId}.json`),
    text,
  );
  return { candidateDigest: draft.candidateDigest, expiresAt };
}
