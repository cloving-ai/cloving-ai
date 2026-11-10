import { issueIdentity } from "../issue-identity.ts";
import { record, type Fields } from "../protocol.ts";
import type { RunView } from "../authority/status.ts";
import { nameOf, ticketOf } from "./run-names.ts";
import type { RunName } from "../run-name.ts";
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

export async function metadataOf(
  context: ServiceContext,
  source: {
    readonly runId: string;
    readonly workflowId: string;
    readonly digest: string | null | undefined;
    readonly input: Fields | null;
  },
): Promise<Fields> {
  const document = source.digest
    ? await context.authority.queries.document(source.digest)
    : undefined;
  const input = record(JSON.parse(document ?? "null"));
  const text = ticketOf(input).text;
  return {
    ticketId: ticketIdOf(input),
    ...(await nameOf(context, {
      ...source,
      stored: input,
      submission: source.input,
    })),
    ...(text === undefined ? {} : { issueIdentity: issueIdentity(text) }),
  };
}

function ticketIdOf(input: Fields | undefined): string | null {
  const ticketId = ticketOf(input).id;
  return ticketId === undefined || ticketId === "" ? null : ticketId;
}

export async function scheduleMetadata(
  context: ServiceContext,
): Promise<Fields> {
  if (context.schedule === undefined) return {};
  const reply = await context.schedule({ action: "list" });
  if (reply.kind !== "result" || !Array.isArray(reply.result["schedules"]))
    return { schedules: { status: "unavailable" } };
  const schedules: readonly unknown[] = reply.result["schedules"];
  if (schedules.length === 0) return {};
  return {
    schedules: schedules.map((value) => {
      const schedule = record(value) ?? {};
      return Object.fromEntries(
        [
          "workflowId",
          "everySeconds",
          "at",
          "timeZone",
          "weekdays",
          "state",
          "failuresInRow",
          "nextAt",
          "nextLocal",
          "stoppedAt",
        ].flatMap((name) =>
          schedule[name] === undefined ? [] : [[name, schedule[name]]],
        ),
      );
    }),
  };
}

export interface LoopMarks {
  readonly scheduled?: { readonly slot: number };
  readonly manualFromLoop?: true;
}

export async function scheduledMetadata(
  context: ServiceContext,
  run: { readonly runId: string; readonly workflowId: string },
): Promise<LoopMarks> {
  const commandId = (await context.authority.queries.run(run.runId))
    ?.admissionCommandId;
  if (
    typeof commandId === "string" &&
    commandId.startsWith(`loop:${run.workflowId}:`)
  )
    return { manualFromLoop: true };
  const prefix = `schedule:${run.workflowId}:`;
  if (typeof commandId !== "string" || !commandId.startsWith(prefix)) return {};
  const suffix = commandId.slice(prefix.length);
  const slot = Number(suffix);
  return /^(0|[1-9][0-9]*)$/.test(suffix) && Number.isSafeInteger(slot)
    ? { scheduled: { slot } }
    : {};
}

export async function submittedInput(
  context: ServiceContext,
  digest: string | null | undefined,
): Promise<Fields | null> {
  const document = digest
    ? await context.authority.queries.document(digest)
    : undefined;
  const request = record(JSON.parse(document ?? "null"));
  return record(request?.["submission"]) ?? null;
}

export async function currentName(
  context: ServiceContext,
  runId: string,
): Promise<RunName> {
  const state = await context.authority.state();
  const details = state.details[runId];
  const workflowIds = await context.authority.queries.workflowIds([runId]);
  const document = details?.input
    ? await context.authority.queries.document(details.input)
    : undefined;
  return nameOf(context, {
    runId,
    workflowId: workflowIds[runId] ?? state.runs[runId]?.workflow ?? "",
    stored: record(JSON.parse(document ?? "null")),
    submission: await submittedInput(context, details?.submission),
  });
}
