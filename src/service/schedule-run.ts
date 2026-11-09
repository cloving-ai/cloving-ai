import { isCommandId, isRecordKey } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import { activeWorkflow } from "./active-tickets.ts";
import {
  failed,
  invalidRequest,
  scheduleRequest,
  type ServiceContext,
} from "./replies.ts";
import {
  admitted,
  conflict,
  submitted,
  type AdmissionLock,
} from "./submission-handler.ts";

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

async function storedLoopRun(
  context: ServiceContext,
  admission: LoopAdmission,
): Promise<Reply | undefined> {
  const { queries } = context.authority;
  const existing = await queries.receipt(admission.commandId);
  if (existing === undefined) return undefined;
  const owners = await queries.workflowIds([existing.runId]);
  return existing.command.kind === "admit-run" &&
    owners[existing.runId] === admission.workflowId
    ? admitted(existing, { workflowId: admission.workflowId, replayed: true })
    : conflict(existing.commandId);
}

async function lockedLoopRun(
  context: ServiceContext,
  run: LoopAdmission & { readonly submission: unknown },
): Promise<Reply> {
  const { workflowId, commandId, submission } = run;
  const stored = await storedLoopRun(context, run);
  if (stored !== undefined) return stored;
  if ((await activeWorkflow(context, workflowId)).length > 0)
    return failed("run-active", {
      commandId,
      detail: `The workflow ${workflowId} has an active run. Run the loop again after that run ends.`,
    });
  return submitted(context, {
    workflowId,
    source: "declared",
    submission,
    commandId,
  });
}

async function loopRun(
  context: ServiceContext,
  request: { readonly admission: LoopAdmission; readonly lock: AdmissionLock },
): Promise<Reply> {
  const { admission, lock } = request;
  const { workflowId, commandId } = admission;
  const stored = await storedLoopRun(context, admission);
  if (stored !== undefined) return stored;
  const found = await scheduleRequest(context, {
    action: "input",
    workflowId,
  });
  if (found.kind === "error") return found;
  return lock([`command:${commandId}`, `workflow:${workflowId}`], () =>
    lockedLoopRun(context, { ...admission, submission: found.result["input"] }),
  );
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
    return loopRun(context, { admission, lock });
  };
}
