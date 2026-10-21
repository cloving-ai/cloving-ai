import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../protocol.ts";
import {
  analysisEvidence,
  validAnalysisImportId,
  type AnalysisSnapshot,
} from "../chats/analysis-input.ts";
import { validateDestination } from "../chats/destination.ts";
import { initialAnalysisCheckpoint } from "../chats/analysis-checkpoint.ts";
import { checkpointProposal } from "../chats/analysis-proposal.ts";
import {
  boundedAnalysisFile,
  matchingPrivateFile,
  readAnalysisCorpus,
  readAnalysisSnapshot,
} from "./chats-files.ts";

export interface AnalysisCapture {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly runId: string;
  readonly importId: string;
  readonly digest: string;
  readonly totalRecords: number;
}

export async function captureAnalysisSnapshot(
  directory: string,
  binding: { readonly runId: string; readonly importId: string },
): Promise<AnalysisCapture> {
  const key = captureKey(binding);
  const folder = join(directory, `capture-${key}`);
  await validateDestination(directory);
  await reclaimAbandonedCaptures(directory);
  const existing = await findAnalysisCapture(directory, binding);
  if (existing !== undefined) return existing;
  const temporary = await mkdtemp(
    join(directory, `.capture-${key}-${String(process.pid)}-`),
  );
  try {
    const capture = await writeCapture(directory, {
      ...binding,
      folder: temporary,
    });
    try {
      await rename(temporary, folder);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      ))
        throw error;
      const published = await findAnalysisCapture(directory, binding);
      if (published === undefined) throw error;
      return published;
    }
    return capture;
  } catch (error) {
    if (missingRedaction(error))
      throw new Error("redaction-required", { cause: error });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function missingRedaction(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT" ||
    !("path" in error) ||
    typeof error.path !== "string"
  )
    return false;
  return (
    error.path.endsWith("/redaction.json") ||
    error.path.endsWith("/redacted.jsonl")
  );
}

async function reclaimAbandonedCaptures(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && absentCaptureOwner(entry.name))
      await rm(join(directory, entry.name), { recursive: true, force: true });
  }
}

function absentCaptureOwner(name: string): boolean {
  const owner = /^\.capture-[a-f0-9]{64}-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(
    name,
  )?.[1];
  if (owner === undefined) return false;
  const processId = Number(owner);
  if (!Number.isSafeInteger(processId)) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

export async function findAnalysisCapture(
  directory: string,
  binding: { readonly runId: string; readonly importId: string },
): Promise<AnalysisCapture | undefined> {
  const folder = join(directory, `capture-${captureKey(binding)}`);
  const stats = await lstat(folder).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return undefined;
  });
  if (stats === undefined) return undefined;
  const capture = await capturedReference(folder, binding);
  await readCapturedAnalysisSnapshot(directory, capture);
  return capture;
}

async function writeCapture(
  directory: string,
  input: {
    readonly folder: string;
    readonly runId: string;
    readonly importId: string;
  },
): Promise<AnalysisCapture> {
  const snapshot = await copiedSnapshot(directory, {
    folder: input.folder,
    importId: input.importId,
  });
  const evidence = analysisEvidence(snapshot);
  const capture: AnalysisCapture = {
    schemaVersion: 1,
    key: captureKey(input),
    runId: input.runId,
    importId: input.importId,
    digest: snapshotDigest(snapshot),
    totalRecords: evidence.records.length,
  };
  await matchingPrivateFile(
    join(input.folder, "capture.json"),
    JSON.stringify(capture) + "\n",
  );
  await ensureInitialCheckpoint(input.folder, capture);
  return capture;
}

export async function readCapturedAnalysisSnapshot(
  directory: string,
  capture: AnalysisCapture,
): Promise<AnalysisSnapshot> {
  const key = captureKey(capture);
  if (capture.key !== key) throw new Error("analysis-input-refused");
  const folder = join(directory, `capture-${key}`);
  const stored = await capturedReference(folder, capture);
  if (
    stored.digest !== capture.digest ||
    stored.totalRecords !== capture.totalRecords ||
    record(capture)?.["schemaVersion"] !== 1
  )
    throw new Error("analysis-input-refused");
  const snapshot = await readAnalysisSnapshot(folder, {
    importId: capture.importId,
    permissions: 0o600,
  });
  const evidence = analysisEvidence(snapshot);
  if (
    snapshotDigest(snapshot) !== capture.digest ||
    evidence.records.length !== capture.totalRecords
  )
    throw new Error("analysis-input-refused");
  await ensureInitialCheckpoint(folder, capture);
  return snapshot;
}

async function ensureInitialCheckpoint(
  folder: string,
  capture: AnalysisCapture,
) {
  const checkpoint = initialAnalysisCheckpoint(capture);
  for (const [name, expected] of [
    ["checkpoint-0.json", JSON.stringify(checkpoint) + "\n"],
    ["proposal-0.txt", checkpointProposal(checkpoint)],
  ] as const) {
    await matchingPrivateFile(join(folder, name), expected);
  }
}

function captureKey(binding: {
  readonly runId: string;
  readonly importId: string;
}): string {
  if (
    !validAnalysisImportId(binding.importId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(binding.runId)
  )
    throw new Error("analysis-input-refused");
  return createHash("sha256")
    .update(JSON.stringify([binding.runId, binding.importId]))
    .digest("hex");
}

function snapshotDigest(snapshot: AnalysisSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function copiedSnapshot(
  directory: string,
  capture: { readonly folder: string; readonly importId: string },
): Promise<AnalysisSnapshot> {
  const redaction = await boundedAnalysisFile(
    join(directory, "redaction.json"),
  );
  await matchingPrivateFile(join(capture.folder, "redaction.json"), redaction);
  const corpus = await readAnalysisCorpus(join(directory, "redacted.jsonl"), {
    output: join(capture.folder, "redacted.jsonl"),
  });
  const structure = await boundedAnalysisFile(
    join(directory, "structure.json"),
  );
  await matchingPrivateFile(join(capture.folder, "structure.json"), structure);
  return { importId: capture.importId, redaction, corpus, structure };
}

async function capturedReference(
  folder: string,
  binding: { readonly runId: string; readonly importId: string },
): Promise<AnalysisCapture> {
  await validateDestination(folder);
  if (((await lstat(folder)).mode & 0o777) !== 0o700)
    throw new Error("analysis-output-failed");
  const value = record(
    JSON.parse(
      await boundedAnalysisFile(join(folder, "capture.json"), {
        permissions: 0o600,
      }),
    ),
  );
  const identity = {
    schemaVersion: 1,
    key: captureKey(binding),
    runId: binding.runId,
    importId: binding.importId,
  };
  if (
    value === undefined ||
    Object.keys(value).length !== 6 ||
    !Object.entries(identity).every(
      ([key, expected]) => value[key] === expected,
    )
  )
    throw new Error("analysis-input-refused");
  const digest = value["digest"];
  const totalRecords = value["totalRecords"];
  if (
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    typeof totalRecords !== "number" ||
    !Number.isSafeInteger(totalRecords) ||
    totalRecords < 0
  )
    throw new Error("analysis-input-refused");
  return {
    schemaVersion: 1,
    key: identity.key,
    runId: binding.runId,
    importId: binding.importId,
    digest,
    totalRecords,
  };
}
