import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../protocol.ts";
import {
  analysisEvidence,
  validAnalysisImportId,
  type AnalysisSnapshot,
} from "../chats/analysis-input.ts";
import { validateDestination } from "../chats/destination.ts";
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
  try {
    await mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
    const capture = await capturedReference(folder, binding);
    await readCapturedAnalysisSnapshot(directory, capture);
    return capture;
  }
  try {
    const snapshot = await copiedSnapshot(directory, {
      folder,
      importId: binding.importId,
    });
    const evidence = analysisEvidence(snapshot);
    const capture: AnalysisCapture = {
      schemaVersion: 1,
      key,
      runId: binding.runId,
      importId: binding.importId,
      digest: snapshotDigest(snapshot),
      totalRecords: evidence.records.length,
    };
    await matchingPrivateFile(
      join(folder, "capture.json"),
      JSON.stringify(capture) + "\n",
    );
    return capture;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    if (
      Reflect.get(Object(error), "code") === "ENOENT" &&
      ["redaction.json", "redacted.jsonl"].some((name) =>
        String(Reflect.get(Object(error), "path")).endsWith(`/${name}`),
      )
    )
      throw new Error("redaction-required", { cause: error });
    throw error;
  }
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
  return snapshot;
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
