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
  readonly settle: (
    noted: Noted & { readonly folder: string },
  ) => Promise<void>;
}

export function recordedNotes(started: unknown): readonly string[] {
  const notes = recordedField(started, "notes");
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is string => typeof note === "string");
}

function agentStarted(started: unknown): boolean {
  if (typeof recordedField(started, "processId") === "number") return true;
  const attempt = recordedField(started, "attempt");
  return (
    recordedField(started, "phase") === "waiting" ||
    (typeof attempt === "number" && attempt > 1)
  );
}

export async function receivedNotes(
  journal: string,
  operationIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const received: Record<string, string> = {};
  for (const operationId of operationIds) {
    const { folder } = located(journal, operationId);
    const started = await readRecord(folder, "started.json");
    const noteIds = agentStarted(started) ? recordedNotes(started) : [];
    for (const noteId of noteIds) received[noteId] = operationId;
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
    settle: async ({ noteIds, folder }) => {
      if (noteIds.length === 0) return;
      if (agentStarted(await readRecord(folder, "started.json"))) return;
      for (const noteId of noteIds) claimed.delete(noteId);
    },
  };
}
