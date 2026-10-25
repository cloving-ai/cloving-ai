import { issueIdentity } from "../issue-identity.ts";
import { record, type Fields } from "../protocol.ts";
import type { RunView } from "../authority/status.ts";
import type { ServiceContext } from "./replies.ts";

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

function titleOf(input: Fields | undefined, workflowId: string): string | null {
  const ticket = input?.["ticket"];
  if (typeof ticket !== "string") return null;
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
  const ticketId = input?.["ticketId"];
  return {
    ticketId: typeof ticketId === "string" && ticketId !== "" ? ticketId : null,
    title: titleOf(input, source.workflowId),
    ...(source.workflowId === "develop-issue"
      ? { issueIdentity: issueIdentity(input?.["ticket"]) }
      : {}),
  };
}
