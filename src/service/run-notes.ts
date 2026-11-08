import type { Fields } from "../protocol.ts";
import type { TurnDetails } from "../record-retention.ts";
import type { WorkerTotals } from "../worker-usage.ts";
import type { ServiceContext } from "./replies.ts";
import { turnDetailsOf } from "./worker-totals.ts";

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

function noteReceipt(
  note: RunNote,
  found: {
    readonly receipts: Readonly<Record<string, string>>;
    readonly details: TurnDetails | undefined;
  },
): Fields {
  const receivedBy = found.receipts[note.noteId] ?? null;
  if (receivedBy !== null || found.details?.state !== "deleted")
    return { ...note, receivedBy };
  return { ...note, receivedBy, receipt: "deleted" };
}

async function notesOf(
  context: ServiceContext,
  run: {
    readonly runId: string;
    readonly continuedFrom?: string;
    readonly turnDetails?: TurnDetails;
  },
): Promise<Fields> {
  if (run.continuedFrom === undefined) return {};
  const { runId } = run;
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
    notes: notes.map((note) =>
      noteReceipt(note, { receipts, details: run.turnDetails }),
    ),
  };
}

export async function turnRecordsOf(
  context: ServiceContext,
  run: {
    readonly runId: string;
    readonly continuedFrom?: string;
    readonly totals: WorkerTotals;
  },
): Promise<Fields> {
  const details = await turnDetailsOf(context, run);
  return { ...details, ...(await notesOf(context, { ...run, ...details })) };
}
