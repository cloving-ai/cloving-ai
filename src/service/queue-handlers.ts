import { record, type Fields, type Reply } from "../protocol.ts";
import { queueOverview, queuePort } from "./active-tickets.ts";
import { isIdentifier as isWorkflowIdentifier } from "../authority/commands.ts";
import type { QueueLaneChange } from "../queue-state.ts";
import { queueOffDetail } from "../queue-state.ts";
import {
  failed,
  invalidRequest,
  isIdentifier,
  result,
  type ServiceContext,
} from "./replies.ts";

const noQueue = failed("queue-unavailable", {
  detail: "The service has no queue workflow.",
});

function selection(context: ServiceContext, parameters: Fields) {
  const ids = context.registry.workflowIds.filter(
    (id) =>
      context.registry.byId(id)?.manifest.queue === true ||
      context.registry.byId(id)?.admission !== undefined ||
      context.queues?.has(id),
  );
  const given = parameters["workflowId"];
  if (given !== undefined && !isWorkflowIdentifier(given))
    return {
      kind: "refused" as const,
      reply: invalidRequest("The queue workflow ID is not valid."),
    };
  if (given === undefined && ids.length > 1)
    return {
      kind: "refused" as const,
      reply: failed("queue-workflow-required", {
        detail: "Select a queue with --workflow <id>.",
      }),
    };
  const workflowId = given ?? ids[0];
  if (workflowId === undefined || !ids.includes(workflowId))
    return { kind: "refused" as const, reply: noQueue };
  return {
    kind: "selected" as const,
    workflowId,
    port: queuePort(context, workflowId),
  };
}

async function selectedOverview(
  context: ServiceContext,
  workflowId: string,
): Promise<Fields> {
  const overview = await queueOverview(context);
  const queues = overview["queues"];
  return {
    ...overview,
    queue: Array.isArray(queues)
      ? queues.map(record).find((queue) => queue?.["workflowId"] === workflowId)
      : undefined,
  };
}

export async function queueRead(
  context: ServiceContext,
  parameters: Fields = {},
): Promise<Reply> {
  const selected = selection(context, parameters);
  if (selected.kind === "refused") return selected.reply;
  const off = selected.port?.control()?.off;
  if (off !== undefined)
    return failed("queue-unavailable", {
      detail: queueOffDetail(off.workflowId),
    });
  const overview = await selectedOverview(context, selected.workflowId);
  if (overview["queue"] === undefined) return noQueue;
  return result("queue", overview);
}

export async function queueCommand(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { command, commandId } = parameters;
  if ((command !== "resume" && command !== "drain") || !isIdentifier(commandId))
    return invalidRequest("The queue command request is not valid.");
  const selected = selection(context, parameters);
  if (selected.kind === "refused") return selected.reply;
  if (selected.port === undefined) return noQueue;
  const change = await selected.port.change({ command, commandId });
  if (change.kind === "unavailable")
    return failed("queue-unavailable", { commandId, detail: change.detail });
  if (change.kind === "conflicting-command")
    return failed("conflicting-command", {
      commandId,
      detail: "The command ID names another queue command.",
    });
  return result("queue-command", {
    command,
    commandId,
    replayed: change.kind === "replayed",
    ...(await selectedOverview(context, selected.workflowId)),
  });
}

function laneRefusal(
  change: QueueLaneChange,
  commandId: string,
): Reply | undefined {
  if (change.kind === "stale")
    return failed("queue-lanes-changed", {
      commandId,
      detail: "The queue lanes changed. Refresh the page and try again.",
    });
  if (change.kind === "unavailable")
    return failed("queue-unavailable", { commandId, detail: change.detail });
  if (change.kind === "conflicting-command")
    return failed("conflicting-command", {
      commandId,
      detail: "The command ID names another queue command.",
    });
  return undefined;
}

function laneWriteDetail(error: unknown): string {
  if (error instanceof Error && error.message === "invalid-queue-working-lanes")
    return "The lane count cannot be below the working lane setting.";
  return "The private queue lanes setting could not be saved.";
}

export async function queueLanes(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { lanes, expectedLanes, commandId, workflowId } = parameters;
  const validLane = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 16;
  if (
    !validLane(lanes) ||
    !validLane(expectedLanes) ||
    !isIdentifier(commandId) ||
    !isWorkflowIdentifier(workflowId)
  )
    return invalidRequest("The queue lanes request is not valid.");
  const selected = selection(context, parameters);
  if (selected.kind === "refused") return selected.reply;
  if (selected.port?.changeLanes === undefined) return noQueue;
  try {
    const change = await selected.port.changeLanes({
      lanes: Number(lanes),
      expectedLanes: Number(expectedLanes),
      commandId,
    });
    const refusal = laneRefusal(change, commandId);
    if (refusal !== undefined) return refusal;
    return result("queue-lanes", {
      commandId,
      replayed: change.kind === "replayed",
      ...(await selectedOverview(context, workflowId)),
    });
  } catch (error) {
    return failed("queue-lanes-failed", {
      commandId,
      detail: laneWriteDetail(error),
    });
  }
}
