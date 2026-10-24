import { isTicketStatus } from "./ticket-status.ts";

export interface DevelopmentInput {
  readonly cycleId: string;
}

export type CycleOutcome =
  | {
      readonly kind: "waiting_for_decision";
      readonly cycleId: string;
      readonly decisionId: string;
    }
  | {
      readonly kind: "blocked";
      readonly cycleId: string;
      readonly reason: string;
      readonly evidenceId: string;
    }
  | {
      readonly kind: "handoff_requested";
      readonly cycleId: string;
      readonly promotionId: string;
      readonly ticketStatus?: "complete" | "partial";
      readonly issueUpdate?: "failed";
      readonly reason?: string;
    };

export type Validation<Value> =
  | { readonly kind: "valid"; readonly value: Value }
  | { readonly kind: "invalid"; readonly reason: string };

const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const reason = /^\S[\s\S]{0,255}$/;

export function isPromotionId(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

export function isBlockedReason(value: unknown): value is string {
  return typeof value === "string" && reason.test(value);
}

const outcomes: Readonly<
  Record<
    string,
    {
      readonly keys: readonly string[];
      readonly optional?: readonly string[];
      readonly parse: (
        fields: Readonly<Record<string, unknown>>,
      ) => CycleOutcome | null;
    }
  >
> = {
  waiting_for_decision: {
    keys: ["cycleId", "decisionId", "kind"],
    parse: (fields) => {
      const cycleId = textField(fields, {
        key: "cycleId",
        pattern: identifier,
      });
      const decisionId = textField(fields, {
        key: "decisionId",
        pattern: identifier,
      });
      if (cycleId === null || decisionId === null) return null;
      return { kind: "waiting_for_decision", cycleId, decisionId };
    },
  },
  blocked: {
    keys: ["cycleId", "evidenceId", "kind", "reason"],
    parse: (fields) => {
      const cycleId = textField(fields, {
        key: "cycleId",
        pattern: identifier,
      });
      const evidenceId = textField(fields, {
        key: "evidenceId",
        pattern: identifier,
      });
      const blocker = fields["reason"];
      if (cycleId === null || evidenceId === null || !isBlockedReason(blocker))
        return null;
      return { kind: "blocked", cycleId, reason: blocker, evidenceId };
    },
  },
  handoff_requested: {
    keys: ["cycleId", "kind", "promotionId"],
    optional: ["ticketStatus", "issueUpdate", "reason"],
    parse: (fields) => {
      const cycleId = textField(fields, {
        key: "cycleId",
        pattern: identifier,
      });
      const promotionId = textField(fields, {
        key: "promotionId",
        pattern: identifier,
      });
      if (cycleId === null || promotionId === null) return null;
      const ticketStatus = fields["ticketStatus"];
      const issueUpdate = fields["issueUpdate"];
      const reason = fields["reason"];
      if (issueUpdate !== undefined && issueUpdate !== "failed") return null;
      if (ticketStatus !== undefined && !isTicketStatus(ticketStatus))
        return null;
      if (reason !== undefined && !isBlockedReason(reason)) return null;
      return {
        kind: "handoff_requested",
        cycleId,
        promotionId,
        ...Object.fromEntries(
          Object.entries({ issueUpdate, ticketStatus, reason }).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      };
    },
  },
};

export function validateDevelopmentInput(
  value: unknown,
): Validation<DevelopmentInput> {
  const fields = exactFields(value, { required: ["cycleId"] });
  const cycleId =
    fields && textField(fields, { key: "cycleId", pattern: identifier });
  if (!cycleId) return { kind: "invalid", reason: "invalid-development-input" };
  return { kind: "valid", value: { cycleId } };
}

export function validateCycleOutcome(
  value: unknown,
  input: DevelopmentInput,
): Validation<CycleOutcome> {
  const kind = exactFields(value, null)?.["kind"];
  const contract =
    typeof kind === "string" && Object.hasOwn(outcomes, kind)
      ? outcomes[kind]
      : undefined;
  const fields =
    contract &&
    exactFields(value, {
      required: contract.keys,
      optional: contract.optional ?? [],
    });
  const outcome = fields && contract.parse(fields);
  if (!outcome || outcome.cycleId !== input.cycleId)
    return { kind: "invalid", reason: "invalid-cycle-outcome" };
  return { kind: "valid", value: outcome };
}

function exactFields(
  value: unknown,
  shape: {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
  } | null,
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.fromEntries(Object.entries(value));
  const keys = shape?.required;
  const optional = shape?.optional ?? [];
  if (
    keys &&
    JSON.stringify(
      Object.keys(fields)
        .filter((key) => !optional.includes(key))
        .sort(),
    ) !== JSON.stringify(keys)
  )
    return null;
  return fields;
}

function textField(
  fields: Readonly<Record<string, unknown>>,
  field: { readonly key: string; readonly pattern: RegExp },
): string | null {
  const { key, pattern } = field;
  const value = fields[key];
  return typeof value === "string" && pattern.test(value) ? value : null;
}
