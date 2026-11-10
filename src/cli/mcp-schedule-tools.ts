import type { Fields, ServiceRequest } from "../protocol.ts";
import { key, mutation, mutationCall, repeat, type Tool } from "./mcp-tool.ts";
import {
  scheduleServiceRequest,
  type ScheduleInvocation,
} from "./schedule-arguments.ts";

function scheduleRequest(
  action: ScheduleInvocation["action"],
  given: { readonly values: Fields; readonly commandId: string | null },
): ServiceRequest {
  const workflowId = given.values["workflowId"];
  return scheduleServiceRequest(
    {
      kind: "schedule",
      action,
      workflowId: typeof workflowId === "string" ? workflowId : null,
      commandId: given.commandId,
      json: true,
    },
    given.commandId,
  );
}

function switchTool(action: "pause" | "resume", description: string): Tool {
  return {
    name: `cloving_schedule_${action}`,
    description,
    arguments: { workflowId: key },
    required: ["workflowId"],
    annotations: mutation,
    call: (values) => ({
      kind: "read",
      request: scheduleRequest(action, { values, commandId: null }),
    }),
  };
}

export const scheduleTools: readonly Tool[] = [
  {
    name: "cloving_schedules",
    description:
      "List the loops: each schedule with its rule, state, next run and failures in a row.",
    arguments: {},
    required: [],
    annotations: { readOnlyHint: true },
    call: (values) => ({
      kind: "read",
      request: scheduleRequest("list", { values, commandId: null }),
    }),
  },
  switchTool(
    "pause",
    "Pause a loop, as cloving schedule pause does. An active run continues. A second pause changes nothing.",
  ),
  switchTool(
    "resume",
    "Resume a paused or stopped loop, as cloving schedule resume does. Resume clears the failures in a row.",
  ),
  {
    name: "cloving_schedule_run",
    description: `Run a loop now, as cloving schedule run does: one manual run with the input of the schedule, marked manual from loop. The next run of the schedule does not change. While a run of the workflow is active, the service refuses with run-active. ${repeat}`,
    arguments: { workflowId: key, commandId: key },
    required: ["workflowId", "commandId"],
    annotations: mutation,
    call: (values) =>
      mutationCall(values, (commandId) =>
        scheduleRequest("run", { values, commandId }),
      ),
  },
];
