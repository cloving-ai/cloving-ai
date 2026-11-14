import { randomUUID, createHash } from "node:crypto";
import {
  linkSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { record } from "../protocol.ts";
import { processMatch, type RecordedProcess } from "./process-identity.ts";

export interface PiRpcNote {
  readonly noteId: string;
  readonly text: string;
  readonly sequence: number;
}

export interface PiRpcOwner extends RecordedProcess {
  readonly piRpc: string;
}

export interface PiRpcReceipt {
  readonly status:
    | "pending"
    | "accepted"
    | "written"
    | "acknowledged"
    | "observed"
    | "uncertain"
    | "unavailable"
    | "conflict";
  readonly reason?: string;
}

export function rpcRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = record(JSON.parse(readFileSync(path, "utf8")));
    if (value === undefined) throw new Error("pi-rpc-evidence-invalid");
    return value;
  } catch (error) {
    if (record(error)?.["code"] === "ENOENT") return undefined;
    throw error;
  }
}

export function rpcWrite(path: string, value: unknown): void {
  const staged = `${path}.staged`;
  writeFileSync(staged, JSON.stringify(value) + "\n", { mode: 0o600 });
  const descriptor = openSync(staged, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(staged, path);
}

export function rpcNoteRequest(owner: PiRpcOwner, note: PiRpcNote) {
  return {
    id: `note-${createHash("sha256").update(note.noteId).digest("hex")}`,
    marker: owner.marker,
    type: "steer",
    noteId: note.noteId,
    sequence: note.sequence,
    message: `Operator note ${note.noteId}:\n\n${note.text}`,
  };
}

function sameRequest(
  request: ReturnType<typeof rpcNoteRequest>,
  existing: Record<string, unknown> | undefined,
): boolean {
  return (
    existing !== undefined &&
    Object.entries(request).every(([key, value]) => existing[key] === value)
  );
}

function ownership(owner: PiRpcOwner): Record<string, unknown> | undefined {
  const state = rpcRecord(join(owner.piRpc, "owner.json"));
  if (state?.["protocol"] !== "pi-1.5.2") return undefined;
  return ["processId", "processStart", "marker"].every(
    (key) => state[key] === Reflect.get(owner, key),
  )
    ? state
    : undefined;
}

function notedReceipt(
  owner: PiRpcOwner,
  request: ReturnType<typeof rpcNoteRequest>,
): PiRpcReceipt {
  const receipt = rpcRecord(
    join(owner.piRpc, "receipts", `${request.id}.json`),
  );
  if (receipt === undefined) return { status: "pending" };
  if (!sameRequest(request, receipt))
    return { status: "conflict", reason: "pi-rpc-note-conflict" };
  if (receipt["observed"] === true && receipt["acknowledged"] === true)
    return { status: "observed" };
  if (receipt["uncertain"] === true)
    return { status: "uncertain", reason: "pi-rpc-delivery-uncertain" };
  return receipt["acknowledged"] === true
    ? { status: "acknowledged" }
    : { status: receipt["written"] === true ? "written" : "accepted" };
}

async function recordedNoteReceipt(
  owner: PiRpcOwner,
  note: PiRpcNote,
): Promise<PiRpcReceipt> {
  const state = ownership(owner);
  if (state === undefined)
    return { status: "conflict", reason: "pi-rpc-ownership-conflict" };
  const request = rpcNoteRequest(owner, note);
  const input = rpcRecord(join(owner.piRpc, "requests", `${request.id}.json`));
  if (input === undefined)
    return { status: "unavailable", reason: "pi-rpc-note-unsubmitted" };
  if (!sameRequest(request, input))
    return { status: "conflict", reason: "pi-rpc-note-conflict" };
  const receipt = notedReceipt(owner, request);
  if (receipt.status === "observed") return receipt;
  if (state["state"] === "running" && (await processMatch(owner)) === "same")
    return receipt;
  return { status: "uncertain", reason: "pi-rpc-delivery-uncertain" };
}

function insertRequest(path: string, request: unknown): void {
  const temporary = `${path}.${randomUUID()}`;
  try {
    rpcWrite(temporary, request);
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

async function submittedNote(
  owner: PiRpcOwner,
  note: PiRpcNote,
): Promise<PiRpcReceipt> {
  const state = ownership(owner);
  if (state === undefined)
    return { status: "conflict", reason: "pi-rpc-ownership-conflict" };
  const request = rpcNoteRequest(owner, note);
  const path = join(owner.piRpc, "requests", `${request.id}.json`);
  if (rpcRecord(path) !== undefined) return piRpcNoteReceipt(owner, note);
  if (state["state"] !== "running" || (await processMatch(owner)) !== "same")
    return { status: "unavailable", reason: "pi-rpc-not-running" };
  try {
    insertRequest(path, request);
  } catch {
    return piRpcNoteReceipt(owner, note);
  }
  return { status: "pending" };
}

export function piRpcNoteReceipt(
  owner: PiRpcOwner,
  note: PiRpcNote,
): Promise<PiRpcReceipt> {
  return recordedNoteReceipt(owner, note).catch(() => ({
    status: "uncertain",
    reason: "pi-rpc-evidence-unreadable",
  }));
}

export function submitPiRpcNote(
  owner: PiRpcOwner,
  note: PiRpcNote,
): Promise<PiRpcReceipt> {
  return submittedNote(owner, note).catch(() => ({
    status: "uncertain",
    reason: "pi-rpc-evidence-unreadable",
  }));
}
