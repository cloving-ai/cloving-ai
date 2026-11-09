import { isRecordKey } from "../authority/commands.ts";
import type { ServiceRequest } from "../protocol.ts";
import { givenCommandId } from "./queue-arguments.ts";

type ScheduleAction = "pause" | "resume" | "run";

export interface ScheduleInvocation {
  readonly kind: "schedule";
  readonly action: "list" | ScheduleAction;
  readonly workflowId: string | null;
  readonly commandId: string | null;
  readonly json: boolean;
}

function scheduleAction(action: string): action is ScheduleAction {
  return ["pause", "resume", "run"].includes(action);
}

export function scheduleInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[];
}): ScheduleInvocation | string {
  const [action, workflowId] = request.positionals;
  const allowed = action === "run" ? ["command-id", "json"] : ["json"];
  if (request.options.some((option) => !allowed.includes(option.name)))
    return "unexpected-option";
  const json = request.options.some((option) => option.name === "json");
  const listed = { kind: "schedule", commandId: null, json } as const;
  if (action === undefined)
    return { ...listed, action: "list", workflowId: null };
  if (!scheduleAction(action)) return "invalid-schedule-action";
  if (workflowId === undefined) return "missing-argument";
  if (request.positionals.length > 2) return "unexpected-argument";
  const commandId = givenCommandId(request.options);
  if (!isRecordKey(workflowId) || commandId === undefined)
    return "invalid-option-value";
  return { ...listed, action, workflowId, commandId };
}

export function scheduleServiceRequest(
  invocation: ScheduleInvocation,
  commandId: string | null,
): ServiceRequest {
  const { action, workflowId } = invocation;
  return {
    operation: "schedule",
    parameters: {
      action,
      ...(workflowId === null ? {} : { workflowId }),
      ...(commandId === null ? {} : { commandId }),
    },
  };
}
