export type MemoryPressure = "normal" | "warn" | "critical" | "unknown";

export type PressureLimit = "normal" | "warn";

export interface HostSignals {
  readonly loadAverage: number;
  readonly cores: number;
  readonly memoryPressure: MemoryPressure;
}

export interface RoomLimits {
  readonly maxLoadPerCore: number;
  readonly maxMemoryPressure: PressureLimit;
}

export interface QueueLimits {
  readonly lanes: number;
  readonly workingLanes: number;
  readonly room?: RoomLimits;
}

export const defaultRoom: RoomLimits = {
  maxLoadPerCore: 0.7,
  maxMemoryPressure: "normal",
};

export function isPressureLimit(value: unknown): value is PressureLimit {
  return value === "normal" || value === "warn";
}

function wholeIn(value: unknown, most: number): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= most
  );
}

function roomOf(value: unknown): RoomLimits | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const load: unknown = Reflect.get(value, "maxLoadPerCore");
  const pressure: unknown = Reflect.get(value, "maxMemoryPressure");
  if (typeof load !== "number" || load < 0.1 || load > 4) return undefined;
  return isPressureLimit(pressure)
    ? { maxLoadPerCore: load, maxMemoryPressure: pressure }
    : undefined;
}

export function queueLimitsOf(value: unknown): QueueLimits | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const lanes: unknown = Reflect.get(value, "lanes");
  const workingLanes: unknown = Reflect.get(value, "workingLanes");
  const given: unknown = Reflect.get(value, "room");
  if (!wholeIn(lanes, 16) || !wholeIn(workingLanes, lanes)) return undefined;
  const room = roomOf(given);
  if (given !== undefined && room === undefined) return undefined;
  return { lanes, workingLanes, ...(room === undefined ? {} : { room }) };
}

export function cpuShare(cores: number, working: number): number {
  return Math.max(1, Math.floor(cores / Math.max(1, working)));
}

export interface HoldPeriod {
  readonly reason: "load" | "memory";
  readonly startedAt: number;
  readonly endedAt: number | null;
}

function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function holdPeriodOf(value: unknown): HoldPeriod | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const reason: unknown = Reflect.get(value, "reason");
  const startedAt: unknown = Reflect.get(value, "startedAt");
  const endedAt: unknown = Reflect.get(value, "endedAt");
  if (reason !== "load" && reason !== "memory") return undefined;
  if (!instant(startedAt)) return undefined;
  if (endedAt !== null && !(instant(endedAt) && endedAt >= startedAt))
    return undefined;
  return { reason, startedAt, endedAt };
}

export type QueueHold =
  | {
      readonly reason: "load";
      readonly loadPerCore: number;
      readonly limit: number;
      readonly text: string;
    }
  | {
      readonly reason: "memory";
      readonly pressure: MemoryPressure;
      readonly limit: PressureLimit;
      readonly text: string;
    }
  | {
      readonly reason: "working-lanes";
      readonly working: number;
      readonly limit: number;
      readonly text: string;
    };

export function workingHold(
  working: number,
  limit: number,
): QueueHold | undefined {
  return working < limit
    ? undefined
    : {
        reason: "working-lanes",
        working,
        limit,
        text: `Held: ${String(working)} of ${String(limit)} working lanes busy`,
      };
}

const pressureOrder: readonly MemoryPressure[] = [
  "normal",
  "warn",
  "critical",
  "unknown",
];

const darwinLevels: Readonly<Record<string, MemoryPressure>> = {
  "1": "normal",
  "2": "warn",
  "4": "critical",
};

export function sysctlPressure(output: string): MemoryPressure {
  return darwinLevels[output.trim()] ?? "unknown";
}

function kibibytes(text: string, name: string): number | undefined {
  const value = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text)?.[1];
  return value === undefined ? undefined : Number(value);
}

export function meminfoPressure(text: string): MemoryPressure {
  const total = kibibytes(text, "MemTotal");
  const available = kibibytes(text, "MemAvailable");
  if (total === undefined || available === undefined || total === 0)
    return "unknown";
  const share = available / total;
  if (share < 0.1) return "critical";
  return share < 0.2 ? "warn" : "normal";
}

export function roomHold(
  signals: HostSignals,
  limits: RoomLimits,
): QueueHold | undefined {
  const measured = signals.loadAverage / Math.max(1, signals.cores);
  const loadPerCore = Math.round(measured * 100) / 100;
  if (measured >= limits.maxLoadPerCore)
    return {
      reason: "load",
      loadPerCore,
      limit: limits.maxLoadPerCore,
      text: `Held: load ${loadPerCore.toFixed(2)} for each core, limit ${limits.maxLoadPerCore.toFixed(2)}`,
    };
  if (
    pressureOrder.indexOf(signals.memoryPressure) >
    pressureOrder.indexOf(limits.maxMemoryPressure)
  )
    return {
      reason: "memory",
      pressure: signals.memoryPressure,
      limit: limits.maxMemoryPressure,
      text: `Held: memory pressure ${signals.memoryPressure}, limit ${limits.maxMemoryPressure}`,
    };
  return undefined;
}
