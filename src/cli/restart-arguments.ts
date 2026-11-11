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
  readonly within: number | null;
  readonly commandId: string | null;
  readonly json: boolean;
}

const units: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 };

function withinSeconds(text: string | undefined): number | null | undefined {
  if (text === undefined) return null;
  const [, count = "", unit = ""] = /^([1-9][0-9]*)([smh])$/.exec(text) ?? [];
  const seconds = Number(count) * (units[unit] ?? Number.NaN);
  return seconds <= 2_592_000 ? seconds : undefined;
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
    ...(cancel
      ? ["cancel"]
      : ["at", "resume-queue", "settings", "update", "within"]),
  ];
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  const valueOf = (name: string): string | undefined =>
    request.options.find((option) => option.name === name)?.value;
  const at = valueOf("at") ?? "keep";
  const settings = valueOf("settings") ?? "environment";
  const commandId = givenCommandId(request.options);
  const within = withinSeconds(valueOf("within"));
  if (
    !isRestartTime(at) ||
    !isRestartSettings(settings) ||
    commandId === undefined ||
    within === undefined
  )
    return "invalid-option-value";
  return {
    kind: "restart",
    at,
    cancel,
    resumeQueue: names.includes("resume-queue"),
    settings,
    update: names.includes("update"),
    within,
    commandId,
    json: names.includes("json"),
  };
}
