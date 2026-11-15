import { queueSettingRequest } from "../queue-setting-operation.ts";
import type { QueueLaneChange } from "../queue-state.ts";
import type { Fields, Reply } from "../protocol.ts";
import { queueOverview, queuePort } from "./active-tickets.ts";
import {
  failed,
  invalidRequest,
  result,
  type ServiceContext,
} from "./replies.ts";
import { reloadUnavailable } from "./workflow-reload.ts";

function eligible(context: ServiceContext, id: string): boolean {
  return (
    context.registry.byId(id)?.manifest.queue === true &&
    queuePort(context, id)?.control()?.off === undefined &&
    queuePort(context, id) !== undefined
  );
}

function refusal(changed: QueueLaneChange): Reply | undefined {
  if (changed.kind === "unavailable")
    return failed("queue-setting-failed", {
      detail: changed.detail,
      ...(changed.saved === true ? { saved: true } : {}),
    });
  if (changed.kind === "conflicting-command")
    return failed("conflicting-command", {
      detail:
        "This request ID names another queue setting. Refresh before retrying.",
    });
  if (changed.kind === "stale")
    return failed("queue-setting-changed", {
      detail: "The effective value changed. Refresh and try again.",
    });
  return undefined;
}

function settingError(error: unknown): Reply {
  const detail =
    error instanceof Error && error.message.startsWith("queue-lanes-apply: ")
      ? error.message.slice("queue-lanes-apply: ".length)
      : "The private setting could not be saved. Check the configuration and retry.";
  return failed("queue-setting-failed", { detail });
}

export async function queueSetting(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const request = queueSettingRequest(parameters);
  if (request === undefined)
    return invalidRequest("The queue setting request is not valid.");
  const ids =
    request.scope === "global"
      ? context.registry.workflowIds
      : [request.workflowId ?? ""];
  if (
    !ids.some((id) => eligible(context, id)) ||
    context.queueSettings?.change === undefined
  )
    return failed("queue-unavailable", {
      detail: "There is no eligible queue for this setting.",
    });
  try {
    const changed = await context.queueSettings.change(
      request,
      () => context.reload?.(request) ?? reloadUnavailable(),
    );
    const refused = refusal(changed);
    if (refused !== undefined) return refused;
    return result("queue-setting", {
      commandId: request.commandId,
      replayed: changed.kind === "replayed",
      ...(await queueOverview(context)),
    });
  } catch (error) {
    return settingError(error);
  }
}
