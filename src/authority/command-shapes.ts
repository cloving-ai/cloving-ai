export type Fields = Readonly<Record<string, unknown>>;

export interface Shape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
  readonly groups?: readonly (readonly string[])[];
  readonly consistent?: (fields: Fields) => boolean;
  readonly validators?: Readonly<Record<string, (value: unknown) => boolean>>;
}

export const reportedOutcomes = ["completed", "failed", "stopped"];

export const effectShapes: Readonly<Record<string, Shape>> = {
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
    optional: [
      "resource",
      "transport",
      "source",
      "sourceGeneration",
      "spendLimitUsd",
      "recordedCostUsd",
    ],
    groups: [
      ["source", "sourceGeneration"],
      ["spendLimitUsd", "recordedCostUsd"],
    ],
  },
  "grant-lease": {
    required: ["operationId", "leaseGeneration", "expiresAt", "capacity"],
    optional: ["queueLimit"],
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
    optional: ["result", "reason", "evidence", "commandOutput"],
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
      "commandOutput",
    ],
  },
};
