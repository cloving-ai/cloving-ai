import {
  queueLaneValue,
  queueSettingRequest,
  type QueueSettingRequest,
} from "./queue-setting-operation.ts";
import { configuration, type Configuration } from "./configuration-schema.ts";
import { parseConfiguration } from "./project-settings.ts";

export interface QueueSettingChange {
  readonly scope: "private";
  readonly queueSetting: {
    readonly request: QueueSettingRequest;
    readonly project?: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly declaredLanes?: number;
  };
}

type Context = QueueSettingChange["queueSetting"];

function refused(detail: string): never {
  throw new Error(`queue-lanes-apply: ${detail}`);
}

function requestValue(request: QueueSettingRequest): number {
  if (!queueLaneValue(request.value))
    return refused("The lane value is invalid.");
  return request.value;
}

function environmentValue(context: Context, name: string): number | undefined {
  const text = context.environment[name];
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!queueLaneValue(value))
    return refused(`The environment override ${name} is invalid.`);
  return value;
}

function controlled(context: Context): void {
  const request = context.request;
  const globalKey =
    request.field === "lanes"
      ? "CLOVING_QUEUE_GLOBAL_LANES"
      : "CLOVING_QUEUE_GLOBAL_WORKING_LANES";
  const key = request.scope === "workflow" ? "CLOVING_QUEUES" : globalKey;
  if (context.environment[key] !== undefined)
    refused(
      `${key} controls this setting through the environment or a retained start override. Change that override first.`,
    );
}

function editedGlobal(
  previous: Partial<Configuration>,
  request: QueueSettingRequest,
): Partial<Configuration> {
  let queue = { ...previous.queue };
  const field =
    request.field === "lanes" ? "globalLanes" : "globalWorkingLanes";
  if (request.action === "set") queue[field] = requestValue(request);
  else {
    queue = Object.fromEntries(
      Object.entries(queue).filter(([key]) => key !== field),
    );
  }
  return { ...previous, queue };
}

function editedWorkflow(
  previous: Partial<Configuration>,
  request: QueueSettingRequest,
): Partial<Configuration> {
  const id = request.workflowId ?? "";
  let own = { ...previous.queues?.[id] };
  if (request.action === "set") own[request.field] = requestValue(request);
  else {
    own = Object.fromEntries(
      Object.entries(own).filter(([key]) => key !== request.field),
    );
  }
  return { ...previous, queues: { ...previous.queues, [id]: own } };
}

function firstValue(
  values: readonly (number | undefined)[],
  fallback: number,
): number {
  return values.find((value) => value !== undefined) ?? fallback;
}

function generalValue(
  next: Partial<Configuration>,
  context: Context & { readonly field: "lanes" | "workingLanes" },
): number | undefined {
  const project = parseConfiguration(context.project, "project");
  const key =
    context.field === "lanes"
      ? "CLOVING_QUEUE_LANES"
      : "CLOVING_QUEUE_WORKING_LANES";
  return [
    environmentValue(context, key),
    next.queue?.[context.field],
    project.queue?.[context.field],
  ].find((value) => value !== undefined);
}

function globalPair(next: Partial<Configuration>, context: Context) {
  const project = parseConfiguration(context.project, "project");
  return {
    lanes: firstValue(
      [
        environmentValue(context, "CLOVING_QUEUE_GLOBAL_LANES"),
        next.queue?.globalLanes,
        project.queue?.globalLanes,
      ],
      16,
    ),
    working: [
      environmentValue(context, "CLOVING_QUEUE_GLOBAL_WORKING_LANES"),
      next.queue?.globalWorkingLanes,
      project.queue?.globalWorkingLanes,
    ].find((value) => value !== undefined),
  };
}

function effectivePair(next: Partial<Configuration>, context: Context) {
  if (context.request.scope === "global") return globalPair(next, context);
  const project = parseConfiguration(context.project, "project");
  const id = context.request.workflowId ?? "";
  const queue = { ...project.queues?.[id], ...next.queues?.[id] };
  return {
    lanes: firstValue(
      [
        queue.lanes,
        generalValue(next, { ...context, field: "lanes" }),
        context.declaredLanes,
      ],
      1,
    ),
    working:
      queue.workingLanes ??
      generalValue(next, { ...context, field: "workingLanes" }),
  };
}

export function queueSettingPair(
  contents: string | undefined,
  context: Context,
): { readonly lanes: number; readonly workingLanes: number } {
  const pair = effectivePair(parseConfiguration(contents, "private"), context);
  return { lanes: pair.lanes, workingLanes: pair.working ?? pair.lanes };
}

function adjustedPair(
  next: Partial<Configuration>,
  context: Context,
): Partial<Configuration> {
  const pair = effectivePair(next, context);
  if (pair.working === undefined || pair.working <= pair.lanes) return next;
  const request = context.request;
  if (request.action !== "set" || request.field !== "lanes")
    return refused(
      "The inherited active-work cap exceeds the lane limit. Increase lanes or lower the active-work cap before using inheritance.",
    );
  if (
    request.scope === "global" &&
    context.environment["CLOVING_QUEUE_GLOBAL_WORKING_LANES"] !== undefined
  )
    return refused(
      "CLOVING_QUEUE_GLOBAL_WORKING_LANES controls the active-work cap through the environment or a retained start override. Change it before reducing lanes.",
    );
  if (request.scope === "global")
    return {
      ...next,
      queue: { ...next.queue, globalWorkingLanes: pair.lanes },
    };
  const id = request.workflowId ?? "";
  return {
    ...next,
    queues: {
      ...next.queues,
      [id]: { ...next.queues?.[id], workingLanes: pair.lanes },
    },
  };
}

export function changedQueueSettingConfiguration(
  contents: string | undefined,
  change: QueueSettingChange,
): string {
  const context = change.queueSetting;
  const request = queueSettingRequest(context.request);
  if (request === undefined)
    return refused("The queue setting request is invalid.");
  controlled(context);
  const previous = parseConfiguration(contents, "private");
  const pair = effectivePair(previous, context);
  const current =
    request.field === "lanes" ? pair.lanes : (pair.working ?? pair.lanes);
  if (current !== request.expectedValue && current !== request.value)
    refused("The setting changed in another editor. Refresh and try again.");
  const edited =
    request.scope === "global"
      ? editedGlobal(previous, request)
      : editedWorkflow(previous, request);
  const next = { version: 1, ...adjustedPair(edited, context) };
  configuration(next, "private");
  return JSON.stringify(next, null, 2) + "\n";
}
