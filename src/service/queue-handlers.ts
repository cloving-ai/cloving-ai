import type { Fields, Reply } from "../protocol.ts";
import { queueOverview } from "./active-tickets.ts";
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

export async function queueRead(context: ServiceContext): Promise<Reply> {
  const overview = await queueOverview(context);
  const off = context.queue?.control()?.off;
  if (off !== undefined)
    return failed("queue-unavailable", {
      detail: queueOffDetail(off.workflowId),
    });
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
  if (context.queue === undefined) return noQueue;
  const change = await context.queue.change({ command, commandId });
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
    ...(await queueOverview(context)),
  });
}
