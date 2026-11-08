import type { Fields } from "../protocol.ts";
import type { ServiceContext } from "./replies.ts";

export interface RunNote {
  readonly noteId: string;
  readonly text: string;
  readonly source: string;
  readonly recordedAt: string;
}

const noteBound = 1000;

export async function runNotes(
  context: Pick<ServiceContext, "authority">,
  runId: string,
): Promise<readonly RunNote[]> {
  const { events } = await context.authority.queries.eventsAfter({
    after: 0,
    limit: noteBound,
    runId,
    type: "run.noted",
  });
  return events.map((event) => ({
    noteId: String(event.payload["noteId"]),
    text: String(event.payload["note"]),
    source: String(event.payload["source"]),
    recordedAt: event.recordedAt,
  }));
}

export async function notesOf(
  context: Pick<ServiceContext, "authority" | "noteReceipts">,
  runId: string,
): Promise<Fields> {
  const notes = await runNotes(context, runId);
  if (notes.length === 0) return {};
  const operations = await context.authority.effects.operations(runId);
  const receipts =
    (await context.noteReceipts?.read(
      operations
        .filter((operation) => operation.capability === "claude")
        .map((operation) => operation.operationId),
    )) ?? {};
  return {
    notes: notes.map((note) => ({
      ...note,
      receivedBy: receipts[note.noteId] ?? null,
    })),
  };
}
