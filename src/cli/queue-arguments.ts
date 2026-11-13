import { isIdentifier, isRecordKey } from "../authority/commands.ts";
import type { ServiceRequest } from "../protocol.ts";

export interface QueueInvocation {
  readonly kind: "queue";
  readonly action: "show" | "resume" | "drain" | "lanes";
  readonly lanes?: number;
  readonly expectedLanes?: number;
  readonly commandId: string | null;
  readonly json: boolean;
  readonly workflowId?: string;
}

export function givenCommandId(
  options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[],
): string | null | undefined {
  const value = options.find((option) => option.name === "command-id")?.value;
  if (value === undefined) return null;
  return isRecordKey(value) ? value : undefined;
}

function workflowTarget(
  options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[],
) {
  const workflowId = options.find(
    (option) => option.name === "workflow",
  )?.value;
  if (workflowId !== undefined && !isIdentifier(workflowId)) return undefined;
  return workflowId === undefined ? {} : { workflowId };
}

export function queueInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[];
}): QueueInvocation | string {
  const [action, ...rest] = request.positionals;
  const names = request.options.map((option) => option.name);
  const allowed =
    action === undefined
      ? ["workflow", "json"]
      : ["workflow", "command-id", "json"];
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  const json = names.includes("json");
  const target = workflowTarget(request.options);
  if (target === undefined) return "invalid-option-value";
  if (action === undefined)
    return { kind: "queue", action: "show", commandId: null, json, ...target };
  return queueMutation({
    action,
    rest,
    target,
    json,
    options: request.options,
  });
}

function queueLaneCount(
  rest: readonly string[],
  workflowId?: string,
): number | undefined {
  const value = rest[0] ?? "";
  if (
    rest.length !== 1 ||
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    Number(value) > 16 ||
    workflowId === undefined
  )
    return undefined;
  return Number(value);
}

function isQueueAction(action: string): action is "resume" | "drain" | "lanes" {
  return action === "resume" || action === "drain" || action === "lanes";
}

function queueMutation(request: {
  readonly action: string;
  readonly rest: readonly string[];
  readonly target: { readonly workflowId?: string };
  readonly json: boolean;
  readonly options: Parameters<typeof givenCommandId>[0];
}): QueueInvocation | string {
  const { action, rest, target, json } = request;
  if (!isQueueAction(action)) return "invalid-queue-action";
  const lanes =
    action === "lanes" ? queueLaneCount(rest, target.workflowId) : undefined;
  if (action === "lanes" && lanes === undefined) return "invalid-option-value";
  if (action !== "lanes" && rest.length > 0) return "unexpected-argument";
  const commandId = givenCommandId(request.options);
  if (commandId === undefined) return "invalid-option-value";
  return {
    kind: "queue",
    action,
    commandId,
    json,
    ...target,
    ...(lanes === undefined ? {} : { lanes }),
  };
}

function queueParameters(invocation: QueueInvocation, commandId: string) {
  if (invocation.action === "show") return {};
  if (invocation.action === "lanes")
    return {
      commandId,
      lanes: invocation.lanes,
      expectedLanes: invocation.expectedLanes,
    };
  return { command: invocation.action, commandId };
}

export function queueServiceRequest(
  invocation: QueueInvocation,
  commandId: string,
): ServiceRequest {
  return {
    operation: {
      show: "queue",
      resume: "queue-command",
      drain: "queue-command",
      lanes: "queue-lanes",
    }[invocation.action],
    parameters: {
      ...queueParameters(invocation, commandId),
      ...(invocation.workflowId === undefined
        ? {}
        : { workflowId: invocation.workflowId }),
    },
  };
}
