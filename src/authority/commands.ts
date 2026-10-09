import type { AuthorityCommand, EventType } from "./transitions.ts";

const identifier = /^[A-Za-z0-9._:/-]{1,128}$/;

export const commandEvents: Readonly<Record<string, EventType>> = {
  "admit-run": "run.created",
  "mark-started": "run.started",
  "open-gate": "gate.opened",
  "decide-gate": "gate.decided",
  "pause-run": "run.paused",
  "resume-run": "run.resumed",
  "complete-run": "run.completed",
  "fail-run": "run.failed",
  "cancel-run": "run.cancelled",
  "record-dispatch": "step.dispatched",
};

const required: Readonly<Record<string, readonly string[]>> = {
  "admit-run": ["workflow"],
  "open-gate": ["gateId", "expectedRevision"],
  "decide-gate": ["gateId", "decision", "expectedRevision"],
  "record-dispatch": ["operationId", "receipt"],
};

export function parseCommand(value: unknown): AuthorityCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.fromEntries(Object.entries(value));
  const { kind, commandId, runId } = fields;
  if (!knownKind(kind) || !isIdentifier(commandId) || !isIdentifier(runId))
    return null;
  if (!completeFields(kind, fields)) return null;
  return { kind, commandId, runId, ...optionalFields(fields) };
}

function knownKind(kind: unknown): kind is string {
  return typeof kind === "string" && Object.hasOwn(commandEvents, kind);
}

function completeFields(
  kind: string,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  const expected = required[kind] ?? ["expectedRevision"];
  const allowed = ["kind", "commandId", "runId", ...expected];
  return (
    Object.keys(fields).every((key) => allowed.includes(key)) &&
    expected.every((key) => validField(key, fields[key]))
  );
}

function optionalFields(
  fields: Readonly<Record<string, unknown>>,
): Omit<AuthorityCommand, "kind" | "commandId" | "runId"> {
  const { expectedRevision, workflow, gateId, decision, operationId, receipt } =
    fields;
  return {
    ...(typeof expectedRevision === "number" ? { expectedRevision } : {}),
    ...(typeof workflow === "string" ? { workflow } : {}),
    ...(typeof gateId === "string" ? { gateId } : {}),
    ...(typeof decision === "string" ? { decision } : {}),
    ...(typeof operationId === "string" ? { operationId } : {}),
    ...(typeof receipt === "string" ? { receipt } : {}),
  };
}

const validators: Readonly<Record<string, (value: unknown) => boolean>> = {
  expectedRevision: (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  operationId: (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 512,
};

function validField(key: string, value: unknown): boolean {
  return (validators[key] ?? isIdentifier)(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}
