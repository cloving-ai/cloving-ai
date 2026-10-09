import type { AuthorityEvent, EventType } from "./transitions.ts";

const identifier = /^[A-Za-z0-9._:/-]{1,128}$/;
const types: readonly EventType[] = [
  "run.created",
  "run.started",
  "gate.opened",
  "gate.decided",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "step.dispatched",
];

export function parseEvent(value: unknown): AuthorityEvent | null {
  const fields = record(value);
  if (!fields) return null;
  const { sequence, type, runId, commandId, recordedAt, request } = fields;
  const payload = textRecord(fields["payload"]);
  const eventType = types.find((item) => item === type);
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    eventType === undefined ||
    !isIdentifier(runId) ||
    !isIdentifier(commandId) ||
    typeof recordedAt !== "string" ||
    typeof request !== "string" ||
    !payload
  )
    return null;
  return {
    sequence,
    type: eventType,
    runId,
    commandId,
    recordedAt,
    request,
    payload,
  };
}

function textRecord(value: unknown): Readonly<Record<string, string>> | null {
  const fields = record(value);
  if (!fields) return null;
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(fields)) {
    if (typeof item !== "string") return null;
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}
