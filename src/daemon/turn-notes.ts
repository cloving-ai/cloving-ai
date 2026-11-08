import { recordedField } from "./claude-recovery.ts";
import { located, readRecord } from "./operation-journal.ts";

export interface OperatorNote {
  readonly noteId: string;
  readonly text: string;
}

export interface NotePort {
  readonly read: (runId: string) => Promise<readonly OperatorNote[]>;
  readonly operations: (runId: string) => Promise<readonly string[]>;
}

export interface Noted {
  readonly prompt: string;
  readonly noteIds: readonly string[];
}

interface NoteRequest {
  readonly runId: string;
  readonly prompt: string;
}

export interface NoteDesk {
  readonly claim: (request: NoteRequest) => Promise<Noted>;
  readonly recorded: (
    request: NoteRequest & { readonly started: unknown },
  ) => Promise<Noted>;
  readonly release: (noted: Noted) => void;
}

export function recordedNotes(started: unknown): readonly string[] {
  const notes = recordedField(started, "notes");
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is string => typeof note === "string");
}

export async function receivedNotes(
  journal: string,
  operationIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const received: Record<string, string> = {};
  for (const operationId of operationIds) {
    const { folder } = located(journal, operationId);
    const started = await readRecord(folder, "started.json");
    for (const noteId of recordedNotes(started)) received[noteId] = operationId;
  }
  return received;
}

function notedPrompt(prompt: string, notes: readonly OperatorNote[]): Noted {
  if (notes.length === 0) return { prompt, noteIds: [] };
  const texts = notes.map((note) => note.text).join("\n\n");
  return {
    prompt: `Notes from the operator:\n\n${texts}\n\n${prompt}`,
    noteIds: notes.map((note) => note.noteId),
  };
}

export function noteMetadata(noted: Pick<Noted, "noteIds">): {
  readonly notes?: readonly string[];
} {
  return noted.noteIds.length === 0 ? {} : { notes: noted.noteIds };
}

const none = (): Promise<readonly never[]> => Promise.resolve([]);

const noNotes: NotePort = { read: none, operations: none };

export function noteDesk(settings: {
  readonly journal: string;
  readonly notes?: NotePort;
}): NoteDesk {
  const { journal } = settings;
  const port = settings.notes ?? noNotes;
  const claimed = new Set<string>();
  return {
    claim: async ({ runId, prompt }) => {
      const notes = await port.read(runId);
      if (notes.length === 0) return notedPrompt(prompt, []);
      const received = await receivedNotes(
        journal,
        await port.operations(runId),
      );
      const pending = notes.filter(
        (note) =>
          !Object.hasOwn(received, note.noteId) && !claimed.has(note.noteId),
      );
      for (const note of pending) claimed.add(note.noteId);
      return notedPrompt(prompt, pending);
    },
    recorded: async ({ runId, prompt, started }) => {
      const noteIds = recordedNotes(started);
      const notes = noteIds.length === 0 ? [] : await port.read(runId);
      return notedPrompt(
        prompt,
        notes.filter((note) => noteIds.includes(note.noteId)),
      );
    },
    release: (noted) => {
      for (const noteId of noted.noteIds) claimed.delete(noteId);
    },
  };
}
