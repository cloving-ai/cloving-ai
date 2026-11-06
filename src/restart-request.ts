import { record } from "./protocol.ts";

export type RestartTime = "gap" | "now";

export interface RestartMark {
  readonly at: RestartTime;
  readonly requestedAt: number;
  readonly commandId: string;
  readonly resumeQueue: boolean;
}

export interface RestartPort {
  readonly pending: () => Promise<RestartMark | undefined>;
  readonly request: (mark: RestartMark) => Promise<void>;
  readonly cancel: () => Promise<boolean>;
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

export function restartText(mark: RestartMark): string {
  return `${JSON.stringify(mark)}\n`;
}
