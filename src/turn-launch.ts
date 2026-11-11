import { record } from "./protocol.ts";

export interface TurnLaunch {
  readonly processId: number;
  readonly processStart: string;
  readonly marker: string;
  readonly output: string;
  readonly offset: number;
  readonly exit: string;
  readonly configuration: string;
  readonly transcript?: TranscriptPlace;
  readonly runner?: RunnerPlace;
}

export interface RunnerPlace {
  readonly folder: string;
  readonly container?: { readonly engine: string; readonly name: string };
}

function recordedContainer(
  value: unknown,
): Pick<RunnerPlace, "container"> | undefined {
  if (value === undefined) return {};
  const fields = record(value);
  const engine = fields?.["engine"];
  const name = fields?.["name"];
  if (typeof engine !== "string" || typeof name !== "string") return undefined;
  return { container: { engine, name } };
}

function recordedRunner(
  value: unknown,
): { readonly runner?: RunnerPlace } | undefined {
  if (value === undefined) return {};
  const fields = record(value);
  const folder = fields?.["folder"];
  const container = recordedContainer(fields?.["container"]);
  if (typeof folder !== "string" || container === undefined) return undefined;
  return { runner: { folder, ...container } };
}

export interface TranscriptPlace {
  readonly path: string;
  readonly offset: number;
}

function recordedTranscript(
  value: unknown,
): { readonly transcript?: TranscriptPlace } | undefined {
  if (value === undefined) return {};
  const fields = record(value);
  const path = fields?.["path"];
  const offset = fields?.["offset"];
  if (typeof path !== "string" || typeof offset !== "number") return undefined;
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return { transcript: { path, offset } };
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
  const transcript = recordedTranscript(fields["transcript"]);
  const runner = recordedRunner(fields["runner"]);
  if (transcript === undefined || runner === undefined) return undefined;
  return {
    processId,
    processStart: String(processStart),
    marker: String(marker),
    output: String(output),
    offset,
    exit: String(exit),
    configuration: String(configuration),
    ...transcript,
    ...runner,
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
