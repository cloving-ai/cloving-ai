import type {
  QueueChange,
  QueueCommand,
  QueuePort,
  ReadyList,
} from "../queue-state.ts";
import { queueControlLimit, type QueueJournal } from "./queue-journal.ts";

export interface QueueRuntime {
  pending: QueueJournal | undefined;
  error: string | undefined;
  ready?: ReadyList | undefined;
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
  readonly connect: (port: QueuePort) => void;
} {
  let connected: QueuePort | undefined;
  return {
    port: {
      control: () => connected?.control(),
      change: (request) =>
        connected?.change(request) ?? Promise.resolve(unavailable),
    },
    connect: (port) => {
      connected = port;
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
      const { pending, error, ready } = runtime;
      if (pending === undefined && error === undefined) return undefined;
      return {
        failedRunIds: [...(pending?.failures ?? [])],
        drain: pending?.drain,
        error,
        ...(ready === undefined ? {} : { ready }),
      };
    },
    change: (request) => {
      const next = changing.then(() => changed(runtime, request));
      changing = next;
      return next;
    },
  };
}
