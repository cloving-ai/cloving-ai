import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  sourceFailure,
  verifyScanSource,
  verifyOpenSource,
  type ScanSource,
} from "./source.ts";
import {
  normalizeTranscript,
  type MessageRecord,
  type Omissions,
} from "./normalize.ts";

export const transcriptLimit = 10_485_760;

export interface SelectedTranscript {
  readonly path: string;
  readonly status: "included" | "unreadable" | "unsupported" | "too-large";
  readonly reason: string;
  readonly digest: string | null;
  readonly recordCount: number;
  readonly omissions: Omissions;
}

export interface ReadTranscript {
  readonly coverage: SelectedTranscript;
  readonly records: readonly MessageRecord[];
}

function refused(path: string, reason: string): ReadTranscript {
  const status = reason === "source-unreadable" ? "unreadable" : "unsupported";
  return {
    coverage: {
      path,
      status: reason === "file-too-large" ? "too-large" : status,
      reason,
      digest: null,
      recordCount: 0,
      omissions: { metadataRecords: 0, thinkingBlocks: 0 },
    },
    records: [],
  };
}

async function boundedBytes(handle: FileHandle): Promise<Buffer | string> {
  const stats = await handle.stat();
  if (!stats.isFile()) return "nonregular-file";
  if (stats.size > transcriptLimit) return "file-too-large";
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= transcriptLimit) {
    const buffer = Buffer.alloc(Math.min(65_536, transcriptLimit + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  if (total > transcriptLimit || (await handle.stat()).size > transcriptLimit)
    return "file-too-large";
  return Buffer.concat(chunks, total);
}

function normalizeBytes(path: string, bytes: Buffer): ReadTranscript {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    const result = refused(path, "invalid-utf8");
    return { ...result, coverage: { ...result.coverage, digest } };
  }
  const result = normalizeTranscript(text, digest);
  return {
    coverage: {
      path,
      status: result.status,
      reason: result.reason,
      digest,
      recordCount: result.records.length,
      omissions: result.omissions,
    },
    records: result.records,
  };
}

async function readSourceBytes(
  path: string,
  inspection: ScanSource | undefined,
): Promise<Buffer | string> {
  const handle = await open(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (inspection === undefined ? constants.O_NOFOLLOW : 0x20000000),
  );
  try {
    if (inspection !== undefined) {
      verifyOpenSource(inspection, await handle.stat());
      await verifyScanSource(inspection);
    }
    return await boundedBytes(handle);
  } finally {
    await handle.close();
  }
}

export async function readTranscript(
  path: string,
  inspection?: ScanSource,
): Promise<ReadTranscript> {
  try {
    if (inspection !== undefined) await verifyScanSource(inspection);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return refused(path, "symbolic-link");
    if (!stats.isFile()) return refused(path, "nonregular-file");
    const bytes = await readSourceBytes(path, inspection);
    const result =
      typeof bytes === "string"
        ? refused(path, bytes)
        : normalizeBytes(path, bytes);
    return scannedResult(result, inspection);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP")
      return refused(path, "symbolic-link");
    return refused(
      path,
      inspection === undefined ? "source-unreadable" : sourceFailure(error),
    );
  }
}

function scannedResult(
  result: ReadTranscript,
  inspection: ScanSource | undefined,
): ReadTranscript {
  if (inspection === undefined || result.coverage.status !== "too-large")
    return result;
  return { ...result, coverage: { ...result.coverage, status: "unsupported" } };
}
