import type { QueueValues } from "./queue-settings.ts";
import { isAfter, isInstant } from "./authority/instants.ts";
import { record, type Fields } from "./protocol.ts";
import type { HoldPeriod, QueueHold } from "./queue-room.ts";

export const queueFailureLimit = 3;

export interface QueueDrain {
  readonly startedAt: number;
  readonly drainedAt: number | null;
}

export const ticketIdentifier = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ReadyTicket {
  readonly id: string;
  readonly readyAt: string;
}

export type ReadyList =
  | { readonly kind: "read"; readonly tickets: readonly ReadyTicket[] }
  | { readonly kind: "failed"; readonly detail: string };

export interface QueueControl {
  readonly failedRunIds: readonly string[];
  readonly drain: QueueDrain | undefined;
  readonly error: string | undefined;
  readonly ready?: ReadyList;
  readonly hold?: QueueHold;
  readonly lanes?: number;
  readonly holds?: readonly HoldPeriod[];
  readonly holdsCutAt?: number | null;
  readonly settings?: QueueValues;
  readonly off?: QueueOff;
}

export function queueOffDetail(workflowId: string): string {
  return `The queues setting turns off the queue of ${workflowId}.`;
}

export interface QueueOff {
  readonly workflowId: string;
  readonly source: "queues setting";
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
    hold: control.hold ?? null,
    holds: [...(control.holds ?? [])],
    holdsCutAt: control.holdsCutAt ?? null,
    ...(control.settings === undefined ? {} : { settings: control.settings }),
  };
}

function readyTicket(value: unknown): ReadyTicket | undefined {
  const fields = record(value);
  const id = fields?.["id"];
  const readyAt = fields?.["readyAt"];
  if (typeof id !== "string" || !ticketIdentifier.test(id)) return undefined;
  if (!isInstant(readyAt)) return undefined;
  return { id, readyAt };
}

function parsedOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

export function readyList(output: string): ReadyList {
  const printed = parsedOutput(output);
  const tickets = Array.isArray(printed) ? printed.map(readyTicket) : [];
  if (!Array.isArray(printed) || tickets.includes(undefined))
    return {
      kind: "failed",
      detail:
        "The ready-ticket command must print a JSON list of objects with an id and a readyAt UTC time.",
    };
  return {
    kind: "read",
    tickets: tickets.filter((ticket) => ticket !== undefined),
  };
}

export function readyFields(
  ready: ReadyList | undefined,
  skippedTicketIds: readonly string[],
): Fields {
  if (ready === undefined) return {};
  if (ready.kind === "failed") return { ready: { failure: ready.detail } };
  const waiting = ready.tickets.filter(
    (ticket) => !skippedTicketIds.includes(ticket.id),
  );
  const count = new Set(waiting.map((ticket) => ticket.id)).size;
  const oldestAt = waiting.reduce<string | null>(
    (oldest, ticket) =>
      oldest === null || isAfter(oldest, ticket.readyAt)
        ? ticket.readyAt
        : oldest,
    null,
  );
  return { ready: { count, oldestAt } };
}
