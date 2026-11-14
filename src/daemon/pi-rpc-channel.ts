import { randomUUID, createHash } from "node:crypto";
import {
  linkSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { recordedLaunch, type TurnLaunch } from "../turn-launch.ts";
import { record } from "../protocol.ts";
import { processMatch, type RecordedProcess } from "./process-identity.ts";

export interface PiRpcNote {
  readonly noteId: string;
  readonly text: string;
  readonly sequence: number;
}

export interface PiRpcOwner extends RecordedProcess {
  readonly inactive?: AbortSignal;
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

function sameRpcSession(
  plan: Record<string, unknown> | undefined,
  session: unknown,
): boolean {
  const expected = record(session);
  const actual = record(plan?.["session"]);
  if (expected === undefined || actual === undefined) return false;
  return [
    "id",
    "path",
    "cwd",
    "timestamp",
    "historicalResponses",
    "historicalTools",
  ].every(
    (key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]),
  );
}

export function piRpcOwnershipFailure(
  launch: TurnLaunch,
  session: unknown,
): string | undefined {
  if (launch.piRpc === undefined) return undefined;
  try {
    const owner = { ...launch, piRpc: launch.piRpc };
    const plan = rpcRecord(join(owner.piRpc, "plan.json"));
    if (
      owner.piRpc !== join(dirname(launch.exit), "pi-rpc") ||
      ownership(owner) === undefined ||
      plan?.["protocol"] !== "pi-1.5.2" ||
      plan["marker"] !== owner.marker ||
      !sameRpcSession(plan, session)
    )
      return "pi-rpc-ownership-conflict";
    piRpcNotes(owner);
    readdirSync(join(owner.piRpc, "receipts"));
    return undefined;
  } catch {
    return "pi-rpc-ownership-conflict";
  }
}

export async function piRpcPriorFailure(
  launch: TurnLaunch,
): Promise<string | undefined> {
  if (launch.piRpc === undefined) return undefined;
  try {
    const owner = { ...launch, piRpc: launch.piRpc };
    const initial = rpcRecord(join(owner.piRpc, "receipts", "initial.json"));
    if (
      !Object.entries({
        id: "initial",
        type: "prompt",
        marker: owner.marker,
        observed: true,
        acknowledged: true,
      }).every(([key, value]) => initial?.[key] === value)
    )
      return "pi-prior-result-uncertain";
    for (const note of piRpcNotes(owner)) {
      if ((await piRpcNoteReceipt(owner, note)).status !== "observed")
        return "pi-prior-result-uncertain";
    }
    return undefined;
  } catch {
    return "pi-prior-result-uncertain";
  }
}

export function piRpcNotes(owner: PiRpcOwner): readonly PiRpcNote[] {
  return readdirSync(join(owner.piRpc, "requests")).map((name) => {
    const fields = rpcRecord(join(owner.piRpc, "requests", name)) ?? {};
    const { noteId, message, sequence } = fields;
    if (
      typeof noteId !== "string" ||
      typeof message !== "string" ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      throw new Error("pi-rpc-note-evidence-invalid");
    const prefix = `Operator note ${noteId}:\n\n`;
    const note = { noteId, text: message.slice(prefix.length), sequence };
    const request = rpcNoteRequest(owner, note);
    if (
      !message.startsWith(prefix) ||
      name !== `${request.id}.json` ||
      !sameRequest(request, fields)
    )
      throw new Error("pi-rpc-note-evidence-invalid");
    return note;
  });
}

export async function reservedPiRpcNotes(
  value: unknown,
): Promise<readonly string[]> {
  const fields = record(value);
  if (fields?.["harness"] !== "pi") return [];
  const launch = recordedLaunch(fields["launch"]);
  if (launch?.piRpc === undefined) return [];
  const owner = { ...launch, piRpc: launch.piRpc };
  const notes = piRpcNotes(owner);
  for (const note of notes) {
    const receipt = await piRpcNoteReceipt(owner, note);
    if (["conflict", "unavailable"].includes(receipt.status))
      throw new Error(receipt.reason ?? "pi-rpc-note-evidence-invalid");
  }
  return notes.map((note) => note.noteId);
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
  if (owner.inactive?.aborted === true)
    return { status: "unavailable", reason: "pi-rpc-observer-released" };
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
