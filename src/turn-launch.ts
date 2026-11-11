import { record } from "./protocol.ts";

export interface TurnLaunch {
  readonly processId: number;
  readonly processStart: string;
  readonly marker: string;
  readonly output: string;
  readonly offset: number;
  readonly exit: string;
  readonly configuration: string;
}

export function recordedLaunch(value: unknown): TurnLaunch | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const { processId, processStart, marker, output, offset } = fields;
  const { exit, configuration } = fields;
  if (typeof processId !== "number" || !Number.isSafeInteger(processId))
    return undefined;
  if (processId <= 0 || typeof offset !== "number") return undefined;
  const texts = [processStart, marker, output, exit, configuration];
  if (!texts.every((text) => typeof text === "string")) return undefined;
  return {
    processId,
    processStart: String(processStart),
    marker: String(marker),
    output: String(output),
    offset,
    exit: String(exit),
    configuration: String(configuration),
  };
}

export function attemptNumber(started: unknown): number | undefined {
  const attempt = record(started)?.["attempt"];
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt))
    return undefined;
  return attempt >= 1 && attempt <= 8 ? attempt : undefined;
}

export function keptLaunch(turn: {
  readonly started: unknown;
  readonly entry: unknown;
}): TurnLaunch | undefined {
  const started = record(turn.started);
  if (started?.["phase"] !== "running") return undefined;
  if (record(turn.entry)?.["endedAt"] !== undefined) return undefined;
  return recordedLaunch(started["launch"]);
}

export function connectableTurn(turn: {
  readonly started: unknown;
  readonly entry: unknown;
}): boolean {
  return (
    keptLaunch(turn) !== undefined &&
    typeof record(turn.entry)?.["startedAt"] === "string"
  );
}
