import { issueIdentity } from "../issue-identity.ts";
import { record, type Fields } from "../protocol.ts";
import type { RunView } from "../authority/status.ts";
import {
  invalidRequest,
  isIdentifier,
  result,
  type ServiceContext,
} from "./replies.ts";

export async function workflowMetadata(
  context: ServiceContext,
  runIds: unknown,
) {
  if (
    !Array.isArray(runIds) ||
    runIds.length === 0 ||
    runIds.length > 500 ||
    !runIds.every(isIdentifier) ||
    new Set(runIds).size !== runIds.length
  )
    return invalidRequest(
      "Workflow metadata needs one to 500 distinct run IDs.",
    );
  const identities = await context.authority.queries.workflowIds(runIds);
  return result("run-workflow-metadata", {
    runs: runIds.map((runId) => ({
      runId,
      workflowId: identities[runId] ?? null,
    })),
  });
}

export async function ticketMetadataPage(
  context: ServiceContext,
  page: { readonly after: string; readonly limit: number },
) {
  const state = await context.authority.state();
  const identifiers = Object.keys(state.runs)
    .sort()
    .filter((runId) => runId > page.after);
  const shown = identifiers.slice(0, page.limit);
  const runs = [];
  for (const runId of shown) {
    const digest = state.details[runId]?.input;
    const document = digest
      ? await context.authority.queries.document(digest)
      : "{}";
    const input = record(JSON.parse(document ?? "null"));
    if (input === undefined)
      throw new Error("report-ticket-metadata-unavailable");
    runs.push({ runId, ticketId: ticketIdOf(input) });
  }
  return result("run-ticket-metadata", {
    runs,
    next: identifiers.length > shown.length ? shown.at(-1) : null,
  });
}

export async function outcomeOf(
  context: ServiceContext,
  view: Pick<RunView, "state" | "runId" | "latestSequence">,
): Promise<Fields | null> {
  if (view.state !== "completed") return null;
  const event = await context.authority.queries.latestCompletion({
    runId: view.runId,
    atOrBefore: view.latestSequence,
  });
  const payload = event?.payload ?? {};
  const kind = payload["outcome"];
  if (kind === undefined) return null;
  const { ticketStatus, promotionId, outcomeReason, issueUpdate } = payload;
  return {
    kind,
    reason: outcomeReason ?? null,
    ...(promotionId === undefined ? {} : { promotionId }),
    ...(ticketStatus === undefined ? {} : { ticketStatus }),
    ...(issueUpdate === "failed" ? { issueUpdate } : {}),
  };
}

function ticketOf(input: Fields | undefined): {
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

function titleOf(input: Fields | undefined, workflowId: string): string | null {
  const ticket = ticketOf(input).text;
  if (ticket === undefined) return null;
  const fallback = `Cloving task ${String(input?.["cycleId"])}`;
  const lines = ticket.split("\n");
  if (workflowId === "develop-prompt") {
    const first = lines.find((line) => /\S/.test(line));
    return first === undefined
      ? fallback
      : first.replace(/^# /, "").trim().slice(0, 200);
  }
  const first = lines[0] ?? "";
  return first.startsWith("# ")
    ? first.slice(2).trim().slice(0, 200)
    : fallback;
}

export async function metadataOf(
  context: ServiceContext,
  source: {
    readonly workflowId: string;
    readonly digest: string | null | undefined;
  },
): Promise<Fields> {
  const document = source.digest
    ? await context.authority.queries.document(source.digest)
    : undefined;
  const input = record(JSON.parse(document ?? "null"));
  return {
    ticketId: ticketIdOf(input),
    title: titleOf(input, source.workflowId),
    ...(source.workflowId === "develop-issue"
      ? { issueIdentity: issueIdentity(input?.["ticket"]) }
      : {}),
  };
}

function ticketIdOf(input: Fields | undefined): string | null {
  const ticketId = ticketOf(input).id;
  return ticketId === undefined || ticketId === "" ? null : ticketId;
}
