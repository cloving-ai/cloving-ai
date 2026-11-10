import { noteReceipt } from "./note-render.ts";
import { part } from "./run-command-render.ts";
import { element, type Shown } from "./watch-element.ts";

export interface WatchNote {
  readonly noteId: string;
  readonly text: string;
  readonly source: string;
  readonly recordedAt: string;
  readonly receipt: string;
}

export function noteWaiting(notes: unknown): boolean {
  return (
    Array.isArray(notes) &&
    notes.some(
      (note: unknown) =>
        part(note, "receivedBy") === null &&
        part(note, "receipt") === undefined,
    )
  );
}

export function notesOf(value: unknown): {
  readonly notes?: readonly WatchNote[];
} {
  if (!Array.isArray(value) || value.length === 0) return {};
  return {
    notes: value.map((note: unknown) => ({
      noteId: String(part(note, "noteId")),
      text: String(part(note, "text")),
      source: String(part(note, "source")),
      recordedAt: String(part(note, "recordedAt")),
      receipt: noteReceipt(note),
    })),
  };
}

export function RunNotes(props: {
  readonly notes: readonly WatchNote[] | undefined;
}): Shown {
  const notes = props.notes ?? [];
  if (notes.length === 0) return null;
  return element("section", {
    class: "run-notes",
    "aria-label": "Notes from the operator",
    children: [
      element("h3", { children: "Notes from the operator" }),
      element("ul", {
        children: notes.map((note) =>
          element("li", {
            key: note.noteId,
            children: [
              element("p", { class: "note-text", children: note.text }),
              element("p", {
                class: "meta",
                children: `${note.recordedAt} · ${note.source} · ${note.receipt}`,
              }),
            ],
          }),
        ),
      }),
    ],
  });
}
