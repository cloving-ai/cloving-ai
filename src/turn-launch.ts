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

export type PlannedLaunch = Omit<TurnLaunch, "processId" | "processStart">;

export function plannedLaunch(value: unknown): PlannedLaunch | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const { marker, output, offset, exit, configuration } = fields;
  if (typeof offset !== "number") return undefined;
  const texts = [marker, output, exit, configuration];
  if (!texts.every((text) => typeof text === "string")) return undefined;
  return {
    marker: String(marker),
    output: String(output),
    offset,
    exit: String(exit),
    configuration: String(configuration),
  };
}

export function recordedLaunch(value: unknown): TurnLaunch | undefined {
  const planned = plannedLaunch(value);
  const fields = record(value);
  if (planned === undefined || fields === undefined) return undefined;
  const { processId, processStart } = fields;
  if (typeof processId !== "number" || !Number.isSafeInteger(processId))
    return undefined;
  if (processId <= 0 || typeof processStart !== "string") return undefined;
  return { processId, processStart, ...planned };
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
