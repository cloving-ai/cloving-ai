import { issueIdentity } from "../issue-identity.ts";
import { record, type Fields } from "../protocol.ts";
import { manualNameOf, runName, type RunName } from "../run-name.ts";
import type { ServiceContext } from "./replies.ts";

const renamePage = 100;

export function ticketOf(input: Fields | undefined): {
  readonly id: string | undefined;
  readonly text: string | undefined;
} {
  const declared = record(record(input?.["input"])?.["ticket"]);
  const id = declared === undefined ? input?.["ticketId"] : declared["id"];
  const text = declared === undefined ? input?.["ticket"] : declared["text"];
  return {
    id: typeof id === "string" ? id : undefined,
    text: typeof text === "string" ? text : undefined,
  };
}

async function renamesOf(
  context: Pick<ServiceContext, "authority">,
  runId: string,
): Promise<readonly Readonly<Record<string, string>>[]> {
  const renames: Readonly<Record<string, string>>[] = [];
  let after = 0;
  for (;;) {
    const { events } = await context.authority.queries.eventsAfter({
      after,
      limit: renamePage,
      runId,
      type: "run.renamed",
    });
    renames.push(...events.map((event) => event.payload));
    const last = events.at(-1);
    if (last === undefined || events.length < renamePage) return renames;
    after = last.sequence;
  }
}

async function pullRequestTitle(
  context: Pick<ServiceContext, "authority">,
  runId: string,
): Promise<string | null> {
  const opened = (await context.authority.effects.operations(runId))
    .filter((operation) => operation.method === "open-pr")
    .flatMap((operation) =>
      operation.result === null ? [] : [operation.result],
    );
  for (const digest of opened.toReversed()) {
    const document = await context.authority.queries.document(digest);
    const title = record(parsedDocument(document))?.["title"];
    if (typeof title === "string") return title;
  }
  return null;
}

function parsedDocument(document: string | undefined): unknown {
  try {
    const value: unknown = JSON.parse(document ?? "null");
    return value;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function nameOf(
  context: Pick<ServiceContext, "authority">,
  run: {
    readonly runId: string;
    readonly workflowId: string;
    readonly stored: Fields | undefined;
    readonly submission: Fields | null;
  },
): Promise<RunName> {
  const ticket = ticketOf(run.stored);
  const cycleId = text(run.stored?.["cycleId"]) ?? run.runId;
  return runName({
    manual: manualNameOf(await renamesOf(context, run.runId)),
    ticket: {
      id: ticket.id ?? null,
      text: ticket.text ?? null,
      issueNumber: issueIdentity(ticket.text)?.number ?? null,
    },
    pullRequestTitle: await pullRequestTitle(context, run.runId),
    input: run.submission,
    prompt: text(run.submission?.["prompt"]),
    fallback: `${run.workflowId} ${cycleId}`,
  });
}
