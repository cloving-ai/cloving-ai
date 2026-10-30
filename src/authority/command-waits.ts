import { isInstant, instantMilliseconds } from "./instants.ts";
interface WaitEvent {
  readonly type: string;
  readonly runId: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, string>>;
}

export interface CommandWaitState {
  readonly runId: string;
  readonly name: string;
  readonly command: string;
  readonly inputDigest: string;
  readonly maximumWaitSeconds: number;
  readonly pollEverySeconds: number;
  readonly startedAt: number;
  readonly deadline: number;
  readonly nextCheckAt: number | null;
  readonly state:
    "waiting" | "timed-out" | "cancelled" | "completed" | "failed";
  readonly checkCount: number;
  readonly checkOperation: string | null;
  readonly lastCheckSettledAt: number | null;
  readonly result: string | null;
  readonly settledAt: number | null;
  readonly reason: string | null;
}

export type CommandWaitsState = Readonly<Record<string, CommandWaitState>>;

export function commandWaitKey(runId: string, name: string): string {
  return JSON.stringify([runId, name]);
}

function openedCommandWait(event: WaitEvent): CommandWaitState {
  const startedAt = instantMilliseconds(event.recordedAt);
  const maximumWaitSeconds = Number(event.payload["maximumWaitSeconds"]);
  return {
    runId: event.runId,
    name: event.payload["waitName"] ?? "",
    command: event.payload["target"] ?? "",
    inputDigest: event.payload["payload"] ?? "",
    maximumWaitSeconds,
    pollEverySeconds: Number(event.payload["pollEverySeconds"]),
    startedAt,
    deadline: startedAt + maximumWaitSeconds * 1000,
    nextCheckAt: startedAt,
    state: "waiting",
    checkCount: 0,
    checkOperation: null,
    lastCheckSettledAt: null,
    result: null,
    settledAt: null,
    reason: null,
  };
}

type WaitChange =
  | { readonly kind: "updated"; readonly waits: CommandWaitsState }
  | { readonly kind: "invalid"; readonly reason: string };

export function timedOut(wait: CommandWaitState): CommandWaitState {
  return {
    ...wait,
    state: "timed-out",
    settledAt: wait.deadline,
    nextCheckAt: null,
    reason: "command-wait-timeout",
  };
}

export function validCommandWaitTime(
  waits: CommandWaitsState,
  event: WaitEvent,
): boolean {
  if (!["run.completed", "run.failed", "run.cancelled"].includes(event.type))
    return true;
  return Object.values(waits).every(
    (wait) =>
      wait.runId !== event.runId ||
      wait.state !== "waiting" ||
      (isInstant(event.recordedAt) &&
        instantMilliseconds(event.recordedAt) >= wait.startedAt),
  );
}

export function closedCommandWaits(
  waits: CommandWaitsState,
  event: WaitEvent,
): CommandWaitsState {
  if (!["run.completed", "run.failed", "run.cancelled"].includes(event.type))
    return waits;
  return Object.fromEntries(
    Object.entries(waits).map(([key, wait]) => {
      if (wait.runId !== event.runId || wait.state !== "waiting")
        return [key, wait];
      if (instantMilliseconds(event.recordedAt) >= wait.deadline)
        return [key, timedOut(wait)];
      return [
        key,
        {
          ...wait,
          state: "cancelled",
          nextCheckAt: null,
          settledAt: instantMilliseconds(event.recordedAt),
          reason: "command-wait-run-ended",
        },
      ];
    }),
  );
}

function opened(waits: CommandWaitsState, event: WaitEvent): WaitChange {
  const key = commandWaitKey(event.runId, event.payload["waitName"] ?? "");
  const previous = waits[key];
  const candidate = openedCommandWait(event);
  if (previous !== undefined && previous.inputDigest !== candidate.inputDigest)
    return { kind: "invalid", reason: "command-wait-input-mismatch" };
  const wait = previous ?? candidate;
  const expired =
    wait.state === "waiting" &&
    instantMilliseconds(event.recordedAt) >= wait.deadline;
  return {
    kind: "updated",
    waits: { ...waits, [key]: expired ? timedOut(wait) : wait },
  };
}

export function commandWaitsAfter(
  waits: CommandWaitsState,
  event: WaitEvent,
): WaitChange {
  if (event.type.startsWith("command-wait.") && !isInstant(event.recordedAt))
    return { kind: "invalid", reason: "invalid-recorded-time" };
  if (event.type === "command-wait.opened") return opened(waits, event);
  if (event.type !== "command-wait.expired")
    return { kind: "updated", waits: closedCommandWaits(waits, event) };
  const key = commandWaitKey(event.runId, event.payload["waitName"] ?? "");
  const previous = waits[key];
  if (previous === undefined)
    return { kind: "invalid", reason: "unknown-command-wait" };
  if (previous.state !== "waiting") return { kind: "updated", waits };
  if (instantMilliseconds(event.recordedAt) < previous.deadline)
    return { kind: "invalid", reason: "command-wait-not-expired" };
  return { kind: "updated", waits: { ...waits, [key]: timedOut(previous) } };
}
