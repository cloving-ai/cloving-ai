import { isRestartTime, type RestartTime } from "../restart-request.ts";
import { givenCommandId } from "./queue-arguments.ts";

export interface RestartInvocation {
  readonly kind: "restart";
  readonly at: RestartTime;
  readonly cancel: boolean;
  readonly resumeQueue: boolean;
  readonly commandId: string | null;
  readonly json: boolean;
}

export function restartInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[];
}): RestartInvocation | string {
  if (request.positionals.length > 0) return "unexpected-argument";
  const names = request.options.map((option) => option.name);
  const cancel = names.includes("cancel");
  const allowed = [
    "command-id",
    "json",
    ...(cancel ? ["cancel"] : ["at", "resume-queue"]),
  ];
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  const at =
    request.options.find((option) => option.name === "at")?.value ?? "gap";
  const commandId = givenCommandId(request.options);
  if (!isRestartTime(at) || commandId === undefined)
    return "invalid-option-value";
  return {
    kind: "restart",
    at,
    cancel,
    resumeQueue: names.includes("resume-queue"),
    commandId,
    json: names.includes("json"),
  };
}
