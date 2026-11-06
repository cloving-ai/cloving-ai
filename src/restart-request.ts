import { record } from "./protocol.ts";

export type RestartTime = "gap" | "now";

export type RestartCancel = "cancelled" | "none" | "started";

export type RestartSettings = "environment" | "files";

export const restartFiles = {
  request: "pending-restart-",
  claimed: "claimed-restart",
  settings: "restart-settings",
  failure: "restart-failure",
} as const;

export interface RestartMark {
  readonly at: RestartTime;
  readonly requestedAt: number;
  readonly commandId: string;
  readonly resumeQueue: boolean;
  readonly settings?: "files";
  readonly update?: true;
}

export interface RestartFailure {
  readonly commandId: string;
  readonly requestedAt: number;
  readonly step: string;
  readonly output: string;
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
  readonly pending: () => Promise<RestartMark | undefined>;
  readonly request: (mark: RestartMark) => Promise<void>;
  readonly cancel: () => Promise<RestartCancel>;
  readonly unresumable: () => Promise<readonly string[]>;
  readonly failure: () => Promise<RestartFailure | undefined>;
}

export function isRestartTime(value: unknown): value is RestartTime {
  return value === "gap" || value === "now";
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

export function restartMark(text: string): RestartMark | undefined {
  const fields = record(parsed(text)) ?? {};
  const { at, requestedAt, commandId } = fields;
  if (!isRestartTime(at) || typeof commandId !== "string") return undefined;
  if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))
    return undefined;
  return {
    at,
    requestedAt,
    commandId,
    resumeQueue: fields["resumeQueue"] === true,
    ...(fields["settings"] === "files" ? { settings: "files" as const } : {}),
    ...(fields["update"] === true ? { update: true as const } : {}),
  };
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

export function restartFailure(text: string): RestartFailure | undefined {
  const { commandId, requestedAt, step, output } = record(parsed(text)) ?? {};
  if (typeof commandId !== "string" || typeof step !== "string")
    return undefined;
  if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))
    return undefined;
  return typeof output === "string"
    ? { commandId, requestedAt, step, output }
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
