import { isTicketStatus } from "../ticket-status.ts";
import { operationScope } from "../operation-identity.ts";
import { isInstant } from "./instants.ts";
import { isBlockedReason, isPromotionId } from "../workflow-contracts.ts";
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
  "request-effect": "effect.requested",
  "grant-lease": "lease.granted",
  "expire-lease": "lease.expired",
  "report-effect": "effect.reported",
  "record-outcome": "operation.reconciled",
  "record-schedule-skip": "schedule.skipped",
};

type Fields = Readonly<Record<string, unknown>>;

interface Shape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  readonly groups?: readonly (readonly string[])[];
  readonly consistent?: (fields: Fields) => boolean;
  readonly validators?: Readonly<Record<string, (value: unknown) => boolean>>;
}

const revised: Shape = { required: ["expectedRevision"] };

const shapes: Readonly<Record<string, Shape>> = {
  "record-schedule-skip": {
    required: ["workflowId", "slot"],
    validators: { slot: positive },
  },
  "admit-run": {
    required: ["workflow"],
    optional: [
      "parentRunId",
      "chainId",
      "submission",
      "input",
      "resolver",
      "effectLimit",
      "capabilities",
    ],
    groups: [
      ["parentRunId", "chainId"],
      ["submission", "input", "resolver"],
      ["effectLimit", "capabilities"],
    ],
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
    consistent: (fields) => {
      const typed = fields["generation"] !== undefined;
      if (typed && fields["decision"] === "denied") return true;
      return (
        (fields["answer"] !== undefined) ===
        (typed && fields["decision"] === "answered")
      );
    },
  },
  "expire-gate": { required: ["gateId"] },
  "pause-run": revised,
  "resume-run": revised,
  "complete-run": {
    required: ["expectedRevision"],
    optional: [
      "outcome",
      "outcomeReason",
      "promotionId",
      "ticketStatus",
      "issueUpdate",
    ],
    validators: {
      outcome: (value) => value === "handoff_requested" || value === "blocked",
      outcomeReason: isBlockedReason,
      promotionId: isPromotionId,
      ticketStatus: isTicketStatus,
      issueUpdate: (value) => value === "failed",
    },
    consistent: (fields) =>
      (fields["outcomeReason"] === undefined ||
        fields["outcome"] !== undefined) &&
      (fields["promotionId"] === undefined ||
        fields["outcome"] === "handoff_requested") &&
      (fields["ticketStatus"] === undefined ||
        fields["outcome"] === "handoff_requested") &&
      (fields["issueUpdate"] === undefined ||
        fields["outcome"] === "handoff_requested"),
  },
  "fail-run": revised,
  "cancel-run": revised,
  "report-observation": {
    required: ["condition", "reason"],
    optional: [
      "evidence",
      "retryAt",
      "attempt",
      "limit",
      "operationId",
      "expectedObservation",
    ],
    groups: [["attempt", "limit"]],
  },
  "record-dispatch": { required: ["operationId", "receipt"] },
  "request-effect": {
    required: [
      "operationId",
      "capability",
      "method",
      "target",
      "payload",
      "inputDigest",
      "units",
      "recoveryLimit",
    ],
    optional: ["resource", "transport", "source", "sourceGeneration"],
    groups: [["source", "sourceGeneration"]],
  },
  "grant-lease": {
    required: ["operationId", "leaseGeneration", "expiresAt", "capacity"],
  },
  "expire-lease": { required: ["operationId", "leaseGeneration"] },
  "report-effect": {
    required: [
      "operationId",
      "inputDigest",
      "leaseGeneration",
      "worker",
      "outcome",
    ],
    optional: ["result", "reason", "evidence"],
    consistent: (fields) =>
      reportedOutcomes.includes(String(fields["outcome"])) &&
      (fields["outcome"] === "failed" ||
        (fields["result"] !== undefined) ===
          (fields["outcome"] === "completed")) &&
      (fields["reason"] !== undefined) === (fields["outcome"] === "failed"),
  },
  "record-outcome": {
    required: ["operationId", "outcome"],
    optional: [
      "leaseGeneration",
      "receipt",
      "worker",
      "result",
      "reason",
      "evidence",
    ],
  },
};

const reportedOutcomes = ["completed", "failed", "stopped"];
const outcomes = [...reportedOutcomes, "accepted", "not-started", "unknown"];

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
  if (!knownKind(kind) || !isCommandId(commandId) || !isRecordKey(runId))
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
      (shape.validators?.[key] ?? validators[key] ?? isIdentifier)(fields[key]),
    ) &&
    (shape.groups ?? []).every((group) => complete(group, fields)) &&
    (shape.consistent?.(fields) ?? true)
  );
}

function complete(group: readonly string[], fields: Fields): boolean {
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

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export const recoveryBound = 10;

function positive(value: unknown): boolean {
  return whole(value) && value > 0;
}

function atMost(value: unknown, limit: number): boolean {
  return whole(value) && value <= limit;
}

function printable(value: unknown): boolean {
  return typeof value === "string" && operation.test(value);
}

function isDigest(value: unknown): boolean {
  return typeof value === "string" && digest.test(value);
}

function parsedList(text: string): readonly unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function isCapabilityList(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const list = parsedList(value);
  return (
    list !== null &&
    list.length <= 64 &&
    list.every(isIdentifier) &&
    list.every(
      (item, index) => index === 0 || String(list[index - 1]) < item,
    ) &&
    JSON.stringify(list) === value
  );
}

const validators: Readonly<Record<string, (value: unknown) => boolean>> = {
  expectedRevision: positive,
  expectedObservation: whole,
  generation: positive,
  attempt: positive,
  limit: positive,
  operationId: printable,
  gateKind: (value) => value === "question" || value === "approval",
  subject: isDigest,
  effectLimit: whole,
  units: whole,
  recoveryLimit: (value) => positive(value) && atMost(value, recoveryBound),
  leaseGeneration: positive,
  sourceGeneration: positive,
  capacity: positive,
  capabilities: isCapabilityList,
  target: printable,
  transport: printable,
  source: printable,
  payload: isDigest,
  inputDigest: isDigest,
  result: isDigest,
  resource: isRecordKey,
  outcome: (value) => typeof value === "string" && outcomes.includes(value),
  condition: (value) => typeof value === "string" && conditions.includes(value),
  expiresAt: isInstant,
  retryAt: isInstant,
};

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

const plainRecord: Readonly<Record<string, unknown>> = {};

export function isRecordKey(value: unknown): value is string {
  return isIdentifier(value) && !(value in plainRecord);
}

export function isCommandId(value: unknown): value is string {
  if (isRecordKey(value)) return true;
  return (
    typeof value === "string" &&
    value.startsWith("handoff:") &&
    printable(value.slice(8)) &&
    operationScope(value.slice(8)) !== null
  );
}
