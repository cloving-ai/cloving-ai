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
  readonly set: Readonly<Record<string, string>>;
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

interface RestartOption {
  readonly name: string;
  readonly value: string | undefined;
}

function setValues(
  options: readonly RestartOption[],
): Readonly<Record<string, string>> | undefined {
  const given = options.filter((option) => option.name === "set");
  const pairs = given.flatMap((option) => {
    const text = String(option.value);
    const split = text.indexOf("=");
    return split > 0
      ? [[text.slice(0, split), text.slice(split + 1)] as const]
      : [];
  });
  return pairs.length === given.length ? Object.fromEntries(pairs) : undefined;
}

type GivenValues = Pick<
  RestartInvocation,
  "at" | "settings" | "set" | "within" | "commandId"
>;

function givenValues(
  options: readonly RestartOption[],
): GivenValues | undefined {
  const valueOf = (name: string): string | undefined =>
    options.find((option) => option.name === name)?.value;
  const at = valueOf("at") ?? "keep";
  const settings = valueOf("settings") ?? "environment";
  const commandId = givenCommandId(options);
  const within = withinSeconds(valueOf("within"));
  const set = setValues(options);
  if (
    !isRestartTime(at) ||
    !isRestartSettings(settings) ||
    commandId === undefined ||
    within === undefined ||
    set === undefined
  )
    return undefined;
  return { at, settings, set, within, commandId };
}

export function restartInvocation(request: {
  readonly positionals: readonly string[];
  readonly options: readonly RestartOption[];
}): RestartInvocation | string {
  if (request.positionals.length > 0) return "unexpected-argument";
  const names = request.options.map((option) => option.name);
  const cancel = names.includes("cancel");
  const allowed = [
    "command-id",
    "json",
    ...(cancel
      ? ["cancel"]
      : ["at", "resume-queue", "set", "settings", "update", "within"]),
  ];
  if (names.some((name) => !allowed.includes(name))) return "unexpected-option";
  const values = givenValues(request.options);
  if (values === undefined) return "invalid-option-value";
  return {
    kind: "restart",
    ...values,
    cancel,
    resumeQueue: names.includes("resume-queue"),
    update: names.includes("update"),
    json: names.includes("json"),
  };
}
