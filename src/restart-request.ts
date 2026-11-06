import { record } from "./protocol.ts";

export type RestartTime = "gap" | "now";

export type RestartCancel = "cancelled" | "none" | "started";

export const restartFiles = {
  request: "pending-restart-",
  claimed: "claimed-restart",
} as const;

export interface RestartMark {
  readonly at: RestartTime;
  readonly requestedAt: number;
  readonly commandId: string;
  readonly resumeQueue: boolean;
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
}

export function isRestartTime(value: unknown): value is RestartTime {
  return value === "gap" || value === "now";
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function restartMark(text: string): RestartMark | undefined {
  const fields = record(parsed(text));
  const at = fields?.["at"];
  const requestedAt = fields?.["requestedAt"];
  const commandId = fields?.["commandId"];
  if (!isRestartTime(at) || typeof commandId !== "string") return undefined;
  if (typeof requestedAt !== "number" || !Number.isSafeInteger(requestedAt))
    return undefined;
  return {
    at,
    requestedAt,
    commandId,
    resumeQueue: fields?.["resumeQueue"] === true,
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
