import { createHash } from "node:crypto";

export interface AcceptanceRequirements {
  readonly staticChecks: readonly string[];
  readonly diagnosticChecks: readonly string[];
  readonly minimumTests: number;
  readonly scenarios: readonly string[];
  readonly artifacts: readonly string[];
  readonly confinement: readonly string[];
}

export interface AcceptancePlan extends AcceptanceRequirements {
  readonly identity: string;
}

export function assembleAcceptancePlan(
  proposed: AcceptanceRequirements,
): AcceptancePlan {
  const requirements = {
    staticChecks: requiredList(proposed.staticChecks),
    diagnosticChecks: requiredList(proposed.diagnosticChecks),
    minimumTests: proposed.minimumTests,
    scenarios: requiredList(proposed.scenarios),
    artifacts: requiredList(proposed.artifacts),
    confinement: [...proposed.confinement],
  };
  if (
    !Number.isSafeInteger(requirements.minimumTests) ||
    requirements.minimumTests < 1 ||
    requirements.confinement.some((value) => value.trim().length === 0)
  )
    throw new Error("invalid-acceptance-plan");
  return {
    ...requirements,
    identity: createHash("sha256")
      .update(JSON.stringify(requirements))
      .digest("hex"),
  };
}

export function isAcceptancePlan(value: unknown): value is AcceptancePlan {
  if (!value || typeof value !== "object") return false;
  const fields = Object.fromEntries(Object.entries(value));
  return (
    typeof fields["identity"] === "string" &&
    typeof fields["minimumTests"] === "number" &&
    [
      "staticChecks",
      "diagnosticChecks",
      "scenarios",
      "artifacts",
      "confinement",
    ].every((key) => isTextList(fields[key]))
  );
}

function isTextList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function requiredList(values: readonly string[]): readonly string[] {
  if (
    values.length === 0 ||
    values.some((value) => value.trim().length === 0) ||
    new Set(values).size !== values.length
  )
    throw new Error("invalid-acceptance-plan");
  return [...values];
}
