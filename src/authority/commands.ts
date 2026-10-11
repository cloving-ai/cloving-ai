import { isInstant } from "./instants.ts";
import {
  numberFields,
  textFields,
  type AuthorityCommand,
  type EventType,
  type NumberField,
  type TextField,
} from "./transitions.ts";

const identifier = /^[A-Za-z0-9._:/-]{1,128}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const operation = /^[\x20-\x7e]{1,512}$/;

export const commandEvents: Readonly<Record<string, EventType>> = {
  "admit-run": "run.created",
  "mark-started": "run.started",
  "open-gate": "gate.opened",
  "register-wait": "gate.wait-registered",
  "decide-gate": "gate.decided",
  "expire-gate": "gate.expired",
  "pause-run": "run.paused",
  "resume-run": "run.resumed",
  "complete-run": "run.completed",
  "fail-run": "run.failed",
  "cancel-run": "run.cancelled",
  "report-observation": "run.observed",
  "record-dispatch": "step.dispatched",
};

type Fields = Readonly<Record<string, unknown>>;

interface Shape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  readonly groups?: readonly (readonly string[])[];
  readonly consistent?: (fields: Fields) => boolean;
}

const revised: Shape = { required: ["expectedRevision"] };

const shapes: Readonly<Record<string, Shape>> = {
  "admit-run": {
    required: ["workflow"],
    optional: ["submission", "input", "resolver"],
    groups: [["submission", "input", "resolver"]],
  },
  "mark-started": revised,
  "open-gate": {
    required: ["gateId", "expectedRevision"],
    optional: ["gateKind", "subject", "prompt", "expiresAt"],
    groups: [["gateKind", "subject", "prompt"]],
    consistent: (fields) =>
      fields["expiresAt"] === undefined || fields["gateKind"] !== undefined,
  },
  "register-wait": { required: ["gateId"] },
  "decide-gate": {
    required: ["gateId", "decision", "expectedRevision"],
    optional: ["generation", "subject", "answer"],
    groups: [["generation", "subject"]],
    consistent: (fields) =>
      (fields["answer"] !== undefined) ===
      (fields["generation"] !== undefined && fields["decision"] === "answered"),
  },
  "expire-gate": { required: ["gateId"] },
  "pause-run": revised,
  "resume-run": revised,
  "complete-run": revised,
  "fail-run": revised,
  "cancel-run": revised,
  "report-observation": {
    required: ["condition", "reason"],
    optional: ["evidence", "retryAt", "attempt", "limit", "operationId"],
    groups: [["attempt", "limit"]],
  },
  "record-dispatch": { required: ["operationId", "receipt"] },
};

const conditions = [
  "working",
  "quota-wait",
  "infrastructure-failure",
  "code-failure",
  "stopped",
];

export function parseCommand(value: unknown): AuthorityCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
  const { kind, commandId, runId } = fields;
  if (!knownKind(kind) || !isRecordKey(commandId) || !isRecordKey(runId))
    return null;
  if (!completeFields(kind, fields)) return null;
  return {
    kind,
    commandId,
    runId,
    ...numbers(fields),
    ...texts(fields),
  };
}

function knownKind(kind: unknown): kind is string {
  return typeof kind === "string" && Object.hasOwn(commandEvents, kind);
}

function completeFields(kind: string, fields: Fields): boolean {
  const shape = shapes[kind] ?? revised;
  const optional = shape.optional ?? [];
  const allowed = [
    "kind",
    "commandId",
    "runId",
    ...shape.required,
    ...optional,
  ];
  const present = optional.filter((key) => fields[key] !== undefined);
  return (
    Object.keys(fields).every((key) => allowed.includes(key)) &&
    [...shape.required, ...present].every((key) =>
      validField(key, fields[key]),
    ) &&
    (shape.groups ?? []).every((group) => whole(group, fields)) &&
    (shape.consistent?.(fields) ?? true)
  );
}

function whole(group: readonly string[], fields: Fields): boolean {
  const present = group.filter((key) => fields[key] !== undefined).length;
  return present === 0 || present === group.length;
}

function numbers(fields: Fields): Partial<Record<NumberField, number>> {
  const result: Partial<Record<NumberField, number>> = {};
  for (const name of numberFields) {
    const value = fields[name];
    if (typeof value === "number") result[name] = value;
  }
  return result;
}

function texts(fields: Fields): Partial<Record<TextField, string>> {
  const result: Partial<Record<TextField, string>> = {};
  for (const name of textFields) {
    const value = fields[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const validators: Readonly<Record<string, (value: unknown) => boolean>> = {
  expectedRevision: positive,
  generation: positive,
  attempt: positive,
  limit: positive,
  operationId: (value) => typeof value === "string" && operation.test(value),
  gateKind: (value) => value === "question" || value === "approval",
  subject: (value) => typeof value === "string" && digest.test(value),
  condition: (value) => typeof value === "string" && conditions.includes(value),
  expiresAt: isInstant,
  retryAt: isInstant,
};

function validField(key: string, value: unknown): boolean {
  return (validators[key] ?? isIdentifier)(value);
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

const plainRecord: Readonly<Record<string, unknown>> = {};

export function isRecordKey(value: unknown): value is string {
  return isIdentifier(value) && !(value in plainRecord);
}
