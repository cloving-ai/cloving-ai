import { isRecordKey } from "../authority/commands.ts";
import type { ServiceRequest } from "../protocol.ts";

export interface QueueInvocation {
  readonly kind: "queue";
  readonly action: "show" | "resume" | "drain";
  readonly commandId: string | null;
  readonly json: boolean;
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

export function queueInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[];
}): QueueInvocation | string {
  const [action, ...rest] = request.positionals;
  const names = request.options.map((option) => option.name);
  const allowed = action === undefined ? ["json"] : ["command-id", "json"];
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  const json = names.includes("json");
  if (action === undefined)
    return { kind: "queue", action: "show", commandId: null, json };
  if (action !== "resume" && action !== "drain") return "invalid-queue-action";
  if (rest.length > 0) return "unexpected-argument";
  const commandId = givenCommandId(request.options);
  if (commandId === undefined) return "invalid-option-value";
  return { kind: "queue", action, commandId, json };
}

export function queueServiceRequest(
  invocation: QueueInvocation,
  commandId: string,
): ServiceRequest {
  return {
    operation: "queue-command",
    parameters: { command: invocation.action, commandId },
  };
}
