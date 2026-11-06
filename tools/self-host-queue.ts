type Environment = Readonly<Record<string, string | undefined>>;

export function queueLanes(environment: Environment): number {
  const value = environment["CLOVING_QUEUE_LANES"];
  if (value === undefined) return 1;
  if (!/^[1-4]$/.test(value))
    throw new Error("The daemon did not start: invalid-queue-lanes");
  if (environment["CLOVING_QUEUE_SECONDS"] === undefined)
    throw new Error("The daemon did not start: queue-lanes-needs-queue");
  return Number(value);
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
