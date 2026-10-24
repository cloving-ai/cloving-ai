import { isCommandId, isRecordKey } from "./commands.ts";
import { eventTypes, type AuthorityEvent } from "./transitions.ts";

export function parseEvent(value: unknown): AuthorityEvent | null {
  const fields = record(value);
  if (!fields) return null;
  const { sequence, type, runId, commandId, recordedAt, request } = fields;
  const payload = textRecord(fields["payload"]);
  const eventType = eventTypes.find((item) => item === type);
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    eventType === undefined ||
    !isRecordKey(runId) ||
    !isCommandId(commandId) ||
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
