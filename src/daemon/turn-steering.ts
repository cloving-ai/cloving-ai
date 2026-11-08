import type { RunningTurn } from "./claude-turn.ts";
import { recordedNotes } from "./turn-notes.ts";

export const steerLimit = 3;

export interface SteerNote {
  readonly noteId: string;
  readonly text: string;
}

export interface SteerRequest extends SteerNote {
  readonly runId: string;
}

export type SteerOutcome =
  | { readonly delivery: "now" }
  | { readonly delivery: "queued"; readonly reason: string };

export type SteerAnswer =
  | { readonly delivery: "now"; readonly operationId: string }
  | { readonly delivery: "queued"; readonly reason: string };

export interface Steering {
  child?: { readonly turn: RunningTurn; sessionId: string | null };
  pending?: { readonly sessionId: string; readonly notes: SteerNote[] };
  readonly accepted: SteerNote[];
}

export function queued(reason: string): {
  readonly delivery: "queued";
  readonly reason: string;
} {
  return { delivery: "queued", reason };
}

export function steerPrompt(notes: readonly SteerNote[]): string {
  const texts = notes.map((note) => note.text).join("\n\n");
  return `A person sent this note while you worked:\n\n${texts}`;
}

export function steeredMetadata(
  metadata: Readonly<Record<string, unknown>>,
  steering: Steering,
): Readonly<Record<string, unknown>> {
  if (steering.accepted.length === 0) return metadata;
  return {
    ...metadata,
    notes: [
      ...recordedNotes(metadata),
      ...steering.accepted.map((note) => note.noteId),
    ],
  };
}

export function steer(
  steering: Steering,
  request: { readonly note: SteerNote; readonly grace: number },
): SteerOutcome {
  const { child } = steering;
  if (child === undefined) return queued("no-open-turn");
  if (child.sessionId === null) return queued("no-session");
  if (steering.accepted.length >= steerLimit) return queued("note-limit");
  steering.accepted.push(request.note);
  const pending = steering.pending ?? {
    sessionId: child.sessionId,
    notes: [],
  };
  pending.notes.push(request.note);
  steering.pending = pending;
  child.turn.stop(request.grace);
  return { delivery: "now" };
}
