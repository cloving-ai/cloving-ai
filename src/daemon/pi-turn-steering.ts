import { setTimeout as delay } from "node:timers/promises";
import {
  piRpcNoteReceipt,
  piRpcNotes,
  submitPiRpcNote,
  type PiRpcOwner,
  type PiRpcNote,
} from "./pi-rpc-channel.ts";
import {
  queued,
  steerLimit,
  type Steering,
  type SteerNote,
  type SteerOutcome,
} from "./turn-steering.ts";
import type { Attempts } from "./turn-attempts.ts";

function deliveredNow(attempts: Attempts, note: PiRpcNote): SteerOutcome {
  const { delivered } = attempts.steering;
  if (!delivered.some((entry) => entry.noteId === note.noteId))
    delivered.push({ noteId: note.noteId, text: note.text });
  return { delivery: "now" };
}

async function observedNote(
  attempts: Attempts,
  request: { readonly owner: PiRpcOwner; readonly note: PiRpcNote },
): Promise<SteerOutcome> {
  const { owner, note } = request;
  const deadline = Date.now() + 5500;
  for (;;) {
    const receipt = await piRpcNoteReceipt(owner, note);
    if (receipt.status === "observed") return deliveredNow(attempts, note);
    if (["uncertain", "conflict", "unavailable"].includes(receipt.status))
      return queued(receipt.reason ?? "pi-rpc-delivery-uncertain");
    if (Date.now() >= deadline) return queued("pi-rpc-delivery-uncertain");
    await delay(25);
  }
}

function selectedNote(
  attempts: Attempts,
  request: { readonly owner: PiRpcOwner; readonly note: SteerNote },
): PiRpcNote | string {
  const { owner, note } = request;
  const notes = piRpcNotes(owner);
  const existing = notes.find((entry) => entry.noteId === note.noteId);
  const count = new Set([
    ...attempts.steering.earlier,
    ...notes.map((entry) => entry.noteId),
  ]).size;
  if (existing === undefined && count >= steerLimit) return "note-limit";
  return { ...note, sequence: existing?.sequence ?? count + 1 };
}

function observerSignal(attempts: Attempts): AbortSignal {
  return AbortSignal.any([
    attempts.stopping.signal,
    ...(attempts.start.release === undefined ? [] : [attempts.start.release]),
  ]);
}

async function delivered(
  attempts: Attempts,
  note: SteerNote,
): Promise<SteerOutcome> {
  const stopping = () => attempts.stopping.signal.aborted;
  if (stopping()) return queued("turn-stopping");
  const child = attempts.steering.child;
  if (child === undefined) return queued("no-open-turn");
  const launch = await child.turn.launch;
  if (launch?.piRpc === undefined) return queued("pi-rpc-command-unsupported");
  const inactive = observerSignal(attempts);
  const owner = { ...launch, piRpc: launch.piRpc, inactive };
  const input = selectedNote(attempts, { owner, note });
  if (typeof input === "string") return queued(input);
  if (stopping()) return queued("turn-stopping");
  const receipt = await submitPiRpcNote(owner, input);
  if (["unavailable", "conflict"].includes(receipt.status))
    return queued(receipt.reason ?? "pi-rpc-not-running");
  return observedNote(attempts, { owner, note: input });
}

export function steerPi(
  attempts: Attempts,
  note: SteerNote,
): Promise<SteerOutcome> {
  const steering: Steering = attempts.steering;
  const outcome = steering.delivery
    .then(() => delivered(attempts, note))
    .catch(() => queued("pi-rpc-evidence-unreadable"));
  steering.delivery = outcome.then(() => undefined);
  return outcome;
}
