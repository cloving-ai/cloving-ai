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
    };

export type Validation<Value> =
  | { readonly kind: "valid"; readonly value: Value }
  | { readonly kind: "invalid"; readonly reason: string };

const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const reason = /^\S[\s\S]{0,255}$/;

const outcomes: Readonly<
  Record<
    string,
    {
      readonly keys: readonly string[];
      readonly parse: (
        fields: Readonly<Record<string, unknown>>,
      ) => CycleOutcome | null;
    }
  >
> = {
  waiting_for_decision: {
    keys: ["cycleId", "decisionId", "kind"],
    parse: (fields) => {
      const cycleId = textField(fields, "cycleId", identifier);
      const decisionId = textField(fields, "decisionId", identifier);
      if (cycleId === null || decisionId === null) return null;
      return { kind: "waiting_for_decision", cycleId, decisionId };
    },
  },
  blocked: {
    keys: ["cycleId", "evidenceId", "kind", "reason"],
    parse: (fields) => {
      const cycleId = textField(fields, "cycleId", identifier);
      const evidenceId = textField(fields, "evidenceId", identifier);
      const blocker = textField(fields, "reason", reason);
      if (cycleId === null || evidenceId === null || blocker === null)
        return null;
      return { kind: "blocked", cycleId, reason: blocker, evidenceId };
    },
  },
  handoff_requested: {
    keys: ["cycleId", "kind", "promotionId"],
    parse: (fields) => {
      const cycleId = textField(fields, "cycleId", identifier);
      const promotionId = textField(fields, "promotionId", identifier);
      if (cycleId === null || promotionId === null) return null;
      return { kind: "handoff_requested", cycleId, promotionId };
    },
  },
};

export function validateDevelopmentInput(
  value: unknown,
): Validation<DevelopmentInput> {
  const fields = exactFields(value, ["cycleId"]);
  const cycleId = fields && textField(fields, "cycleId", identifier);
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
  const fields = contract && exactFields(value, contract.keys);
  const outcome = fields && contract.parse(fields);
  if (!outcome || outcome.cycleId !== input.cycleId)
    return { kind: "invalid", reason: "invalid-cycle-outcome" };
  return { kind: "valid", value: outcome };
}

function exactFields(
  value: unknown,
  keys: readonly string[] | null,
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = Object.fromEntries(Object.entries(value));
  if (
    keys &&
    JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify(keys)
  )
    return null;
  return fields;
}

function textField(
  fields: Readonly<Record<string, unknown>>,
  key: string,
  pattern: RegExp,
): string | null {
  const value = fields[key];
  return typeof value === "string" && pattern.test(value) ? value : null;
}
