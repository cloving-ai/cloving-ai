import type { HoldPeriod, QueueHold, QueueLimits } from "../queue-room.ts";
import {
  queueOffDetail,
  type QueueChange,
  type QueueCommand,
  type QueuePort,
  type ReadyList,
} from "../queue-state.ts";
import { queueControlLimit, type QueueJournal } from "./queue-journal.ts";
import type { QueueValues, SourcedValue } from "../queue-settings.ts";

export interface QueueRuntime {
  pending: QueueJournal | undefined;
  error: string | undefined;
  ready?: ReadyList | undefined;
  hold?: QueueHold | undefined;
  readonly limits?: () => QueueLimits;
  readonly interval?: SourcedValue;
  holds?: {
    readonly periods: () => readonly HoldPeriod[];
    readonly cutAt: () => number | null;
  };
  readonly stopping: AbortController;
}

interface QueueRequest {
  readonly command: QueueCommand;
  readonly commandId: string;
}

const unavailable: QueueChange = {
  kind: "unavailable",
  detail: "The queue is not running.",
};

export function queueConnection(): {
  readonly port: QueuePort;
  readonly ports: ReadonlyMap<string, QueuePort>;
  readonly connect: (port: QueuePort, workflowId?: string) => void;
} {
  let connected: QueuePort | undefined;
  const ports = new Map<string, QueuePort>();
  return {
    port: {
      control: () => connected?.control(),
      change: (request) =>
        connected?.change(request) ?? Promise.resolve(unavailable),
    },
    ports,
    connect: (port, workflowId) => {
      if (workflowId === undefined) {
        connected = port;
        return;
      }
      ports.set(workflowId, port);
      connected = ports.get([...ports.keys()].sort()[0] ?? "");
    },
  };
}

export function queueOffPort(workflowId: string): QueuePort {
  return {
    control: () => ({
      failedRunIds: [],
      drain: undefined,
      error: undefined,
      off: { workflowId, source: "queues setting" },
    }),
    change: () =>
      Promise.resolve({
        kind: "unavailable",
        detail: queueOffDetail(workflowId),
      }),
  };
}

function settingsOf(runtime: QueueRuntime): {
  readonly settings?: QueueValues;
} {
  const limits = runtime.limits?.();
  const { interval } = runtime;
  if (limits?.sources === undefined || interval === undefined) return {};
  return {
    settings: {
      everySeconds: interval,
      lanes: { value: limits.lanes, source: limits.sources.lanes },
      workingLanes: {
        value: limits.workingLanes,
        source: limits.sources.workingLanes,
      },
    },
  };
}

export function queueStopped(runtime: QueueRuntime, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  runtime.error = reason;
  runtime.stopping.abort();
  process.stderr.write(`Queue stopped: ${JSON.stringify(reason)}\n`);
  return reason;
}

function stoppedChange(error: string): QueueChange {
  return {
    kind: "unavailable",
    detail: `The queue stopped: ${error}. Restart the service.`,
  };
}

function recorded(
  pending: QueueJournal,
  request: QueueRequest,
): QueueChange | undefined {
  const prior = pending.controls.find(
    (control) => control.commandId === request.commandId,
  );
  if (prior === undefined) return undefined;
  return {
    kind:
      prior.command === request.command ? "replayed" : "conflicting-command",
  };
}

function applied(pending: QueueJournal, command: QueueCommand): void {
  if (command === "drain") {
    pending.drain ??= { startedAt: Date.now(), drainedAt: null };
    return;
  }
  pending.failures.length = 0;
  pending.drain = undefined;
}

async function changed(
  runtime: QueueRuntime,
  request: QueueRequest,
): Promise<QueueChange> {
  const { pending, error } = runtime;
  if (error !== undefined) return stoppedChange(error);
  if (pending === undefined) return unavailable;
  const prior = recorded(pending, request);
  if (prior !== undefined) return prior;
  applied(pending, request.command);
  pending.controls.push(request);
  pending.controls.splice(0, pending.controls.length - queueControlLimit);
  try {
    await pending.save();
    return { kind: "changed" };
  } catch (failure) {
    return stoppedChange(queueStopped(runtime, failure));
  }
}

export function queueControlPort(runtime: QueueRuntime): QueuePort {
  let changing: Promise<unknown> = Promise.resolve();
  return {
    control: () => {
      const { pending, error, ready, hold, limits, holds } = runtime;
      if (pending === undefined && error === undefined) return undefined;
      return {
        failedRunIds: [...(pending?.failures ?? [])],
        drain: pending?.drain,
        error,
        ...(ready === undefined ? {} : { ready }),
        ...(hold === undefined ? {} : { hold }),
        ...(limits === undefined ? {} : { lanes: limits().lanes }),
        ...settingsOf(runtime),
        ...(holds === undefined
          ? {}
          : { holds: holds.periods(), holdsCutAt: holds.cutAt() }),
      };
    },
    change: (request) => {
      const next = changing.then(() => changed(runtime, request));
      changing = next;
      return next;
    },
  };
}
