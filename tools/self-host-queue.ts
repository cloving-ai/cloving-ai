import {
  defaultRoom,
  isPressureLimit,
  type QueueLimits,
} from "../src/queue-room.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const laneCount = /^(?:[1-9]|1[0-6])$/;

function refusedStart(code: string): never {
  throw new Error(`The daemon did not start: ${code}`);
}

function queued(environment: Environment, code: string): void {
  if (environment["CLOVING_QUEUE_SECONDS"] === undefined) refusedStart(code);
}

export function queueLanes(environment: Environment): number {
  const value = environment["CLOVING_QUEUE_LANES"];
  if (value === undefined) return 1;
  if (!laneCount.test(value)) refusedStart("invalid-queue-lanes");
  queued(environment, "queue-lanes-needs-queue");
  return Number(value);
}

function workingLanes(environment: Environment, lanes: number): number {
  const value = environment["CLOVING_QUEUE_WORKING_LANES"];
  if (value === undefined) return lanes;
  if (!laneCount.test(value) || Number(value) > lanes)
    refusedStart("invalid-queue-working-lanes");
  queued(environment, "queue-working-lanes-needs-queue");
  return Number(value);
}

function maxLoadPerCore(environment: Environment): number {
  const value = environment["CLOVING_QUEUE_MAX_LOAD_PER_CORE"];
  if (value === undefined) return defaultRoom.maxLoadPerCore;
  const limit = Number(value);
  if (!/^\d+(?:\.\d+)?$/.test(value) || limit < 0.1 || limit > 4)
    refusedStart("invalid-queue-max-load-per-core");
  queued(environment, "queue-max-load-needs-queue");
  return limit;
}

function maxMemoryPressure(environment: Environment) {
  const value = environment["CLOVING_QUEUE_MAX_MEMORY_PRESSURE"];
  if (value === undefined) return defaultRoom.maxMemoryPressure;
  if (!isPressureLimit(value))
    refusedStart("invalid-queue-max-memory-pressure");
  queued(environment, "queue-max-memory-needs-queue");
  return value;
}

export function queueLimits(environment: Environment): QueueLimits {
  const lanes = queueLanes(environment);
  return {
    lanes,
    workingLanes: workingLanes(environment, lanes),
    room: {
      maxLoadPerCore: maxLoadPerCore(environment),
      maxMemoryPressure: maxMemoryPressure(environment),
    },
  };
}

export function queueSpendLimit(environment: Environment): number | undefined {
  const value = environment["CLOVING_QUEUE_DAILY_SPEND_USD"];
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0)
    throw new Error("The daemon did not start: invalid-queue-spend-limit");
  if (environment["CLOVING_QUEUE_SECONDS"] === undefined)
    throw new Error("The daemon did not start: queue-spend-limit-needs-queue");
  return limit;
}

export function readyTicketCommand(
  environment: Environment,
): readonly string[] | undefined {
  const command = listedSetting(environment, "CLOVING_READY_COMMAND");
  if (
    command !== undefined &&
    environment["CLOVING_QUEUE_SECONDS"] === undefined
  )
    throw new Error("The daemon did not start: ready-command-needs-queue");
  return command;
}

export function queueInterval(environment: Environment): number | undefined {
  const value = environment["CLOVING_QUEUE_SECONDS"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(seconds) ||
    seconds < 10 ||
    seconds > 3600
  )
    throw new Error("The daemon did not start: invalid-queue-seconds");
  return seconds * 1000;
}

export function listedSetting(
  environment: Environment,
  name: string,
): readonly string[] | undefined {
  const given = environment[name];
  if (given === undefined) return undefined;
  const list: unknown = JSON.parse(given);
  if (!Array.isArray(list) || !list.every((part) => typeof part === "string"))
    throw new Error(`${name} is not a JSON list of texts.`);
  return list.map(String);
}
