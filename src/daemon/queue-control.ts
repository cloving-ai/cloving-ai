import type { QueueChange, QueueCommand, QueuePort } from "../queue-state.ts";
import { queueControlLimit, type QueueJournal } from "./queue-journal.ts";

export interface QueueRuntime {
  pending: QueueJournal | undefined;
  error: string | undefined;
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

function recorded(
  pending: QueueJournal,
  request: { readonly command: QueueCommand; readonly commandId: string },
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

export function queueControlPort(runtime: QueueRuntime): QueuePort {
  return {
    control: () => {
      const { pending, error } = runtime;
      if (pending === undefined && error === undefined) return undefined;
      return {
        failedRunIds: [...(pending?.failures ?? [])],
        drain: pending?.drain,
        error,
      };
    },
    change: async (request) => {
      const { pending, error } = runtime;
      if (error !== undefined)
        return {
          kind: "unavailable",
          detail: `The queue stopped: ${error}. Restart the service.`,
        };
      if (pending === undefined) return unavailable;
      const prior = recorded(pending, request);
      if (prior !== undefined) return prior;
      applied(pending, request.command);
      pending.controls.push(request);
      pending.controls.splice(0, pending.controls.length - queueControlLimit);
      await pending.save();
      return { kind: "changed" };
    },
  };
}
