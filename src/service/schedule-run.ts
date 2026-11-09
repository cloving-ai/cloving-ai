import { isCommandId, isRecordKey } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import { activeWorkflow } from "./active-tickets.ts";
import {
  failed,
  invalidRequest,
  scheduleRequest,
  type ServiceContext,
} from "./replies.ts";
import { submitted, type AdmissionLock } from "./submission-handler.ts";

interface LoopAdmission {
  readonly workflowId: string;
  readonly commandId: string;
}

function loopAdmission(parameters: Fields): LoopAdmission | undefined {
  const { workflowId, commandId } = parameters;
  if (!isRecordKey(workflowId) || !isRecordKey(commandId)) return undefined;
  const admission = `loop:${workflowId}:${commandId}`;
  return isCommandId(admission)
    ? { workflowId, commandId: admission }
    : undefined;
}

async function loopRun(
  context: ServiceContext,
  admission: LoopAdmission,
): Promise<Reply> {
  const { workflowId, commandId } = admission;
  const found = await scheduleRequest(context, {
    action: "input",
    workflowId,
  });
  if (found.kind === "error") return found;
  const known = await context.authority.queries.receipt(commandId);
  if (
    known === undefined &&
    (await activeWorkflow(context, workflowId)).length > 0
  )
    return failed("run-active", {
      commandId,
      detail: `The workflow ${workflowId} has an active run. Run the loop again after that run ends.`,
    });
  return submitted(context, {
    workflowId,
    source: "declared",
    submission: found.result["input"],
    commandId,
  });
}

export function scheduleHandler(
  context: ServiceContext,
  lock: AdmissionLock,
): (parameters: Fields) => Promise<Reply> {
  return async (parameters) => {
    if (parameters["action"] !== "run")
      return scheduleRequest(context, parameters);
    const admission = loopAdmission(parameters);
    if (admission === undefined)
      return invalidRequest(
        "Use run with a workflow ID and a command ID of at most 128 characters together.",
      );
    return lock(
      [`command:${admission.commandId}`, `workflow:${admission.workflowId}`],
      () => loopRun(context, admission),
    );
  };
}
