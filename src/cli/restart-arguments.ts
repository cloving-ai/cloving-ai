import {
  isRestartSettings,
  isRestartTime,
  type RestartSettings,
  type RestartTime,
} from "../restart-request.ts";
import { givenCommandId } from "./queue-arguments.ts";

export interface RestartInvocation {
  readonly kind: "restart";
  readonly at: RestartTime;
  readonly cancel: boolean;
  readonly resumeQueue: boolean;
  readonly settings: RestartSettings;
  readonly update: boolean;
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
    ...(cancel ? ["cancel"] : ["at", "resume-queue", "settings", "update"]),
  ];
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  const valueOf = (name: string): string | undefined =>
    request.options.find((option) => option.name === name)?.value;
  const at = valueOf("at") ?? "gap";
  const settings = valueOf("settings") ?? "environment";
  const commandId = givenCommandId(request.options);
  if (
    !isRestartTime(at) ||
    !isRestartSettings(settings) ||
    commandId === undefined
  )
    return "invalid-option-value";
  return {
    kind: "restart",
    at,
    cancel,
    resumeQueue: names.includes("resume-queue"),
    settings,
    update: names.includes("update"),
    commandId,
    json: names.includes("json"),
  };
}
