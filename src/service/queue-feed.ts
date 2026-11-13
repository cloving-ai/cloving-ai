import type { CommandRecord } from "../broker/actor/authority.ts";
import type { FeedRegistration, Registered } from "./registry.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import { workflowPin } from "../broker/workflow-pin.ts";
import { executionCapabilities } from "../execution-pin.ts";
import { isCommandId, isIdentifier } from "../authority/commands.ts";
import { checkedFeedResult, internalFeedPrefix } from "../queue-feed.ts";
import { type Fields, type Reply } from "../protocol.ts";
import {
  activeWorkflow,
  currentLanes,
  laneCount,
  repositoryQueueRefusal,
} from "./active-tickets.ts";
import { admissionKeys, type AdmissionLock } from "./admission-lock.ts";
import { spendLimitRefusal } from "./queue-spend.ts";
import { runIdentity, admitted } from "./submission-handler.ts";
import {
  committed,
  failed,
  invalidRequest,
  rejection,
  result,
  type ServiceContext,
} from "./replies.ts";

async function feedStatus(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const runId = parameters["runId"];
  if (!isIdentifier(runId))
    return invalidRequest("A feed status needs a run ID.");
  const ids = await context.authority.queries.workflowIds([runId]);
  if (!(ids[runId] ?? "").startsWith(internalFeedPrefix))
    return failed("unknown-run", {});
  const run = await context.authority.queries.run(runId);
  if (run === undefined) return failed("unknown-run", {});
  if (run.status !== "completed")
    return result("queue-feed-status", { state: run.status });
  return completedFeed(context, { runId, sequence: run.sequence });
}

async function completedFeed(
  context: ServiceContext,
  run: { readonly runId: string; readonly sequence: number },
): Promise<Reply> {
  const { runId } = run;
  const completion = await context.authority.queries.latestCompletion({
    runId,
    atOrBefore: run.sequence,
  });
  const digest = completion?.payload["result"];
  const body =
    typeof digest === "string"
      ? await context.authority.queries.document(digest)
      : undefined;
  const checked =
    body === undefined ? undefined : checkedFeedResult(JSON.parse(body));
  return checked === undefined
    ? failed("invalid-feed-result", {})
    : result("queue-feed-status", {
        state: "completed",
        result: checked,
        at: completion?.recordedAt,
      });
}

async function startFeed(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { workflowId, commandId } = parameters;
  if (!isIdentifier(workflowId) || !isCommandId(commandId))
    return invalidRequest("Invalid feed request.");
  const parent = currentLanes(context, context.registry.byId(workflowId));
  const feed = parent?.feed;
  if (
    parent === undefined ||
    feed === undefined ||
    parent.manifest.queue !== true
  )
    return failed("queue-feed-missing", {});
  if (parent.availability !== "available")
    return failed("workflow-unavailable", {});
  const internalId = internalFeedPrefix + workflowId;
  const existing = await context.authority.queries.receipt(commandId);
  const submission = JSON.stringify({
    workflowId: internalId,
    source: "queue-feed",
    submission: {},
  });
  if (existing !== undefined)
    return replayFeed(existing, { workflowId: internalId, submission });
  const refusal = await feedRefusal(context, parent);
  if (refusal !== undefined) return refusal;
  const input = "null";
  return storeFeed(context, {
    feed,
    workflowId: internalId,
    commandId,
    submission,
    input,
  });
}

function replayFeed(
  existing: CommandRecord,
  request: { readonly workflowId: string; readonly submission: string },
): Reply {
  return existing.command.submission === documentDigest(request.submission)
    ? admitted(existing, { workflowId: request.workflowId, replayed: true })
    : failed("conflicting-command", {});
}

async function feedRefusal(
  context: ServiceContext,
  parent: Registered,
): Promise<Reply | undefined> {
  const workflowId = parent.workflowId;
  const internalId = internalFeedPrefix + workflowId;
  if ((await activeWorkflow(context, internalId)).length > 0)
    return failed("feed-active", {});
  if (
    (await activeWorkflow(context, workflowId)).length >=
    laneCount(parent.admission ?? 1)
  )
    return failed("workflow-active", {});
  return (
    (await repositoryQueueRefusal(context, {})) ??
    (await spendLimitRefusal(context, {}))
  );
}

interface FeedAdmission {
  readonly feed: FeedRegistration;
  readonly workflowId: string;
  readonly commandId: string;
  readonly submission: string;
  readonly input: string;
}

async function storeFeed(
  context: ServiceContext,
  admission: FeedAdmission,
): Promise<Reply> {
  const {
    feed,
    workflowId: internalId,
    commandId,
    submission,
    input,
  } = admission;
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: {
      kind: "admit-run",
      commandId,
      runId: runIdentity(commandId),
      workflow: workflowPin(feed.manifest),
      submission: documentDigest(submission),
      input: documentDigest(input),
      resolver: "queue-feed:1",
      effectLimit: feed.effectLimit,
      capabilities: executionCapabilities(feed.manifest),
    },
    documents: [submission, input],
  });
  if (!committed(receipt)) return rejection(receipt, { commandId });
  const stored = await context.authority.queries.receipt(commandId);
  return stored === undefined
    ? failed("authority-unavailable", {})
    : admitted(stored, {
        workflowId: internalId,
        replayed: receipt.kind === "duplicate",
      });
}

export function queueFeedHandler(context: ServiceContext, lock: AdmissionLock) {
  return (parameters: Fields): Promise<Reply> =>
    parameters["action"] === "status"
      ? feedStatus(context, parameters)
      : lock(
          admissionKeys({
            commandId: String(parameters["commandId"]),
            workflowId: String(parameters["workflowId"]),
            queue: true,
          }),
          () => startFeed(context, parameters),
        );
}
