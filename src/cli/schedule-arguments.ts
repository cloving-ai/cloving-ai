import { isRecordKey } from "../authority/commands.ts";
import type { ServiceRequest } from "../protocol.ts";

export interface ScheduleInvocation {
  readonly kind: "schedule";
  readonly action: "list" | "pause" | "resume";
  readonly workflowId: string | null;
  readonly json: boolean;
}

export function scheduleInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly { readonly name: string }[];
}): ScheduleInvocation | string {
  if (request.options.some((option) => option.name !== "json"))
    return "unexpected-option";
  const [action, workflowId] = request.positionals;
  const json = request.options.some((option) => option.name === "json");
  if (action === undefined)
    return { kind: "schedule", action: "list", workflowId: null, json };
  if (action !== "pause" && action !== "resume")
    return "invalid-schedule-action";
  if (workflowId === undefined) return "missing-argument";
  if (request.positionals.length > 2) return "unexpected-argument";
  if (!isRecordKey(workflowId)) return "invalid-option-value";
  return { kind: "schedule", action, workflowId, json };
}

export function scheduleServiceRequest(
  invocation: ScheduleInvocation,
): ServiceRequest {
  return {
    operation: "schedule",
    parameters:
      invocation.workflowId === null
        ? { action: invocation.action }
        : { action: invocation.action, workflowId: invocation.workflowId },
  };
}
