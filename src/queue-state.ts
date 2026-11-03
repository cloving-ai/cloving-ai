import type { Fields } from "./protocol.ts";

export const queueFailureLimit = 3;

export interface QueueDrain {
  readonly startedAt: number;
  readonly drainedAt: number | null;
}

export interface QueueControl {
  readonly failedRunIds: readonly string[];
  readonly drain: QueueDrain | undefined;
  readonly error: string | undefined;
}

export type QueueCommand = "resume" | "drain";

export type QueueChange =
  | { readonly kind: "changed" | "replayed" | "conflicting-command" }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface QueuePort {
  readonly control: () => QueueControl | undefined;
  readonly change: (request: {
    readonly command: QueueCommand;
    readonly commandId: string;
  }) => Promise<QueueChange>;
}

function stopReason(control: QueueControl): string | undefined {
  if (control.error !== undefined) return control.error;
  if (control.failedRunIds.length >= queueFailureLimit) return "failure-limit";
  return undefined;
}

function drainState(drain: QueueDrain, busy: number): string {
  return drain.drainedAt === null || busy > 0 ? "draining" : "drained";
}

function stateName(control: QueueControl, busy: number): string {
  if (control.error !== undefined) return "stopped";
  if (control.drain !== undefined) return drainState(control.drain, busy);
  if (stopReason(control) !== undefined) return "stopped";
  return "running";
}

export function queueStateFields(control: QueueControl, busy: number): Fields {
  const reason = stopReason(control);
  return {
    state: stateName(control, busy),
    stop: reason === undefined ? null : { reason },
    failedRunIds: [...control.failedRunIds],
    drain:
      control.drain === undefined
        ? null
        : {
            startedAt: control.drain.startedAt,
            drainedAt: control.drain.drainedAt,
          },
  };
}
