import { settingScope, validateSetting } from "./configuration-schema.ts";
import { settingValue } from "./configuration-change.ts";
import {
  harnessCommandVariables,
  settingVariables,
  withoutFileVariables,
  workerSettingVariables,
} from "./project-settings.ts";
import { record } from "./protocol.ts";

export type RestartTime = "keep" | "gap" | "now";

export type RestartCancel = "cancelled" | "none" | "started";

export type RestartSettings = "environment" | "files";

export const restartFiles = {
  request: "pending-restart-",
  claimed: "claimed-restart",
  settings: "restart-settings",
  variables: "restart-variables",
  failure: "restart-failure",
} as const;

export interface RestartMark {
  readonly at: RestartTime;
  readonly requestedAt: number;
  readonly commandId: string;
  readonly resumeQueue: boolean;
  readonly settings?: "files";
  readonly variables?: Readonly<Record<string, string>>;
  readonly update?: true;
  readonly deadline?: number;
}

export interface RestartProblem {
  readonly code: string;
  readonly step: string;
  readonly output: string;
}

export interface RestartFailure extends RestartProblem {
  readonly commandId: string;
  readonly requestedAt: number;
}

export interface RestartEntry {
  readonly name: string;
  readonly text: string;
}

export interface RestartRequest {
  readonly name: string;
  readonly mark: RestartMark;
}

export interface RestartPort {
  readonly validate?: ValidateRestart;
  readonly pending: () => Promise<RestartMark | undefined>;
  readonly request: (mark: RestartMark) => Promise<void>;
  readonly cancel: () => Promise<RestartCancel>;
  readonly unresumable: () => Promise<readonly string[]>;
  readonly failure: () => Promise<RestartFailure | undefined>;
}

export interface RestartSettingRefusal {
  readonly key: string;
  readonly detail: string;
}

export type ValidateRestart = (
  mark: RestartMark,
) => Promise<RestartSettingRefusal | undefined>;

const restartTimes: readonly unknown[] = ["keep", "gap", "now"];

export function isRestartTime(value: unknown): value is RestartTime {
  return restartTimes.includes(value);
}

export function isRestartSettings(value: unknown): value is RestartSettings {
  return value === "environment" || value === "files";
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const variableNames = new Set([
  ...Object.values(settingVariables),
  ...harnessCommandVariables,
]);

export function textRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const texts = Object.entries(fields).flatMap(([name, text]) =>
    typeof text === "string" ? [[name, text] as const] : [],
  );
  return texts.length === Object.keys(fields).length
    ? Object.fromEntries(texts)
    : undefined;
}

export function restartVariables(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const variables = textRecord(value);
  if (variables === undefined) return undefined;
  return Object.keys(variables).every((name) => variableNames.has(name))
    ? variables
    : undefined;
}

export type SetVariables =
  | {
      readonly kind: "variables";
      readonly variables: Readonly<Record<string, string>>;
    }
  | { readonly kind: "refused"; readonly key: string; readonly error: unknown };

interface SetRequest {
  readonly set: Readonly<Record<string, string>>;
  readonly worker: string | undefined;
}

function selectedWorker(request: SetRequest): unknown {
  const name = request.set["harness.name"];
  return name === undefined ? request.worker : settingValue(name);
}

function variableOf(key: string, request: SetRequest): string {
  const variables =
    key === "harness.command"
      ? workerSettingVariables(selectedWorker(request))
      : settingVariables;
  const variable = Object.hasOwn(variables, key) ? variables[key] : undefined;
  if (variable !== undefined) return variable;
  settingScope(key);
  throw new Error(`invalid-setting: ${key} has no environment variable`);
}

function setVariable(
  [key, text]: readonly [string, string],
  request: SetRequest,
): readonly [string, string] {
  const variable = variableOf(key, request);
  const value = settingValue(text);
  validateSetting(key, value);
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  if (encoded.includes("\u0000"))
    throw new Error(`invalid-setting: ${key} has a NUL character`);
  return [variable, encoded];
}

function checkOrder(
  set: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  const entries = Object.entries(set);
  const command = ([key]: readonly [string, string]): boolean =>
    key === "harness.command";
  return [
    ...entries.filter((entry) => !command(entry)),
    ...entries.filter(command),
  ];
}

export function setVariables(request: SetRequest): SetVariables {
  const variables: (readonly [string, string])[] = [];
  for (const entry of checkOrder(request.set)) {
    try {
      variables.push(setVariable(entry, request));
    } catch (error) {
      return { kind: "refused", key: entry[0], error };
    }
  }
  return { kind: "variables", variables: Object.fromEntries(variables) };
}

function markVariables(
  value: unknown,
): Pick<RestartMark, "variables"> | undefined {
  if (value === undefined) return {};
  const variables = restartVariables(value);
  return variables === undefined ? undefined : { variables };
}

export function restartMark(text: string): RestartMark | undefined {
  const fields = record(parsed(text)) ?? {};
  const { at, requestedAt, commandId } = fields;
  const variables = markVariables(fields["variables"]);
  if (!isRestartTime(at) || typeof commandId !== "string" || !variables)
    return undefined;
  if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))
    return undefined;
  return {
    at,
    requestedAt,
    commandId,
    resumeQueue: fields["resumeQueue"] === true,
    ...(fields["settings"] === "files" ? { settings: "files" as const } : {}),
    ...variables,
    ...(fields["update"] === true ? { update: true as const } : {}),
    ...(Number.isSafeInteger(fields["deadline"])
      ? { deadline: Number(fields["deadline"]) }
      : {}),
  };
}

export function restartedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  notes: { readonly settings: string; readonly variables: string },
): NodeJS.ProcessEnv {
  const kept =
    notes.settings === "files"
      ? withoutFileVariables(environment)
      : { ...environment };
  return { ...kept, ...restartVariables(parsed(notes.variables)) };
}

export function isRestartRequest(name: string): boolean {
  return name.startsWith(restartFiles.request);
}

function requestOf(entry: RestartEntry): readonly RestartRequest[] {
  const mark = restartMark(entry.text);
  return mark === undefined ? [] : [{ name: entry.name, mark }];
}

function newer(
  newest: RestartRequest | undefined,
  next: RestartRequest,
): RestartRequest {
  if (newest === undefined) return next;
  return next.mark.requestedAt > newest.mark.requestedAt ? next : newest;
}

export function newestRestart(
  entries: readonly RestartEntry[],
): RestartRequest | undefined {
  return entries
    .flatMap(requestOf)
    .reduce<RestartRequest | undefined>(newer, undefined);
}

export function restartText(mark: RestartMark): string {
  return `${JSON.stringify(mark)}\n`;
}

export function claimText(mark: RestartMark, hostProcessId: number): string {
  return `${JSON.stringify({ ...mark, hostProcessId })}\n`;
}

export function claimHost(text: string): number | undefined {
  const hostProcessId = record(parsed(text))?.["hostProcessId"];
  if (typeof hostProcessId !== "number") return undefined;
  return Number.isSafeInteger(hostProcessId) && hostProcessId > 0
    ? hostProcessId
    : undefined;
}

export function restartFailure(text: string): RestartFailure | undefined {
  const { commandId, requestedAt, code, step, output } =
    record(parsed(text)) ?? {};
  if (typeof commandId !== "string" || typeof code !== "string")
    return undefined;
  if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))
    return undefined;
  return typeof step === "string" && typeof output === "string"
    ? { commandId, requestedAt, code, step, output }
    : undefined;
}

export function restartFailureText(failure: RestartFailure): string {
  return `${JSON.stringify(failure)}\n`;
}

export function serialCalls(): <Value>(
  work: () => Promise<Value>,
) => Promise<Value> {
  let order: Promise<unknown> = Promise.resolve();
  return <Value>(work: () => Promise<Value>): Promise<Value> => {
    const next = order.then(work);
    order = next.catch(() => undefined);
    return next;
  };
}
