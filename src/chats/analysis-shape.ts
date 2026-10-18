import type { AnalysisCandidate, AnalysisCode } from "./analysis-contract.ts";
import { forbiddenAnalysisField } from "./analysis-data.ts";

export function analysisObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function label(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function fields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).every(
    (key) => expected.includes(key) || forbiddenAnalysisField(key),
  );
}

const itemFields = ["id", "description"];
const claimFields = [
  ...itemFields,
  "kind",
  "sourceRefs",
  "counterevidenceRefs",
];
const kinds = [
  "explicit-human-instruction",
  "observed-repetition",
  "assistant-claim",
  "exception",
  "rejected-approach",
  "uncertain-inference",
];
const activities = [
  "work",
  "routine-repair",
  "accidental-interruption",
  "tool-imposed-confirmation",
];
const decisions = [
  "design-decision",
  "configured-action-approval",
  "factual-input",
];
const collections = [
  "inputs",
  "stages",
  "branches",
  "loops",
  "artifacts",
  "stoppingConditions",
  "gates",
  "nonGates",
];

function references(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(
    (ref: unknown) =>
      analysisObject(ref) &&
      fields(ref, ["recordIndex", "sourceId"]) &&
      Number.isSafeInteger(ref["recordIndex"]) &&
      Number(ref["recordIndex"]) >= 0 &&
      text(ref["sourceId"]),
  );
}

function missingSources(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function questionChoices(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4)
    return false;
  const ids = new Set<string>();
  return value.every((choice: unknown) => {
    if (
      !analysisObject(choice) ||
      !fields(choice, itemFields) ||
      !text(choice["id"]) ||
      !text(choice["description"]) ||
      ids.has(choice["id"])
    )
      return false;
    ids.add(choice["id"]);
    return true;
  });
}

function inspectQuestionShape(
  candidate: Record<string, unknown>,
  codes: Set<AnalysisCode>,
): boolean {
  if (!Object.hasOwn(candidate, "openQuestion")) return true;
  const question = candidate["openQuestion"];
  if (!analysisObject(question)) {
    codes.add("invalid-question");
    return false;
  }
  if (
    !fields(question, ["claimId", "description", "sourceRefs", "choices"]) ||
    !text(question["claimId"]) ||
    !text(question["description"]) ||
    !questionChoices(question["choices"])
  )
    codes.add("invalid-question");
  const sources = question["sourceRefs"];
  if (missingSources(sources)) {
    codes.add("missing-source");
    return false;
  }
  if (!references(sources)) codes.add("invalid-question");
  return !codes.has("invalid-question");
}

function inspectClaim(
  value: Record<string, unknown>,
  codes: Set<AnalysisCode>,
): void {
  if (!label(value["kind"], kinds)) codes.add("unknown-kind");
  const source = value["sourceRefs"];
  if (missingSources(source)) codes.add("missing-source");
  else if (!references(source)) codes.add("invalid-shape");
  if (!references(value["counterevidenceRefs"])) codes.add("invalid-shape");
}

function inspectLoop(
  value: Record<string, unknown>,
  codes: Set<AnalysisCode>,
): boolean {
  const limit = value["maxIterations"];
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    codes.add("invalid-loop-limit");
  const stageIds = value["stageIds"];
  return (
    fields(value, [
      ...claimFields,
      "stageIds",
      "maxIterations",
      "exitCondition",
      "exhaustedStoppingConditionId",
    ]) &&
    Array.isArray(stageIds) &&
    stageIds.length > 0 &&
    stageIds.every(text) &&
    new Set(stageIds).size === stageIds.length &&
    text(value["exitCondition"]) &&
    text(value["exhaustedStoppingConditionId"])
  );
}

function claimShape(
  value: Record<string, unknown>,
  context: { collection: string; codes: Set<AnalysisCode> },
): boolean {
  const { collection, codes } = context;
  inspectClaim(value, codes);
  switch (collection) {
    case "stages":
      return (
        fields(value, [...claimFields, "activity"]) &&
        label(value["activity"], activities)
      );
    case "gates":
      if (!label(value["type"], decisions)) codes.add("unknown-decision-type");
      return (
        fields(value, [...claimFields, "stageId", "type"]) &&
        text(value["stageId"])
      );
    case "loops":
      return inspectLoop(value, codes);
    default:
      return false;
  }
}

function itemShape(
  value: Record<string, unknown>,
  context: { collection: string; codes: Set<AnalysisCode> },
): boolean {
  const { collection } = context;
  if (["stages", "gates", "loops"].includes(collection))
    return claimShape(value, context);
  switch (collection) {
    case "branches":
      return (
        fields(value, [
          ...itemFields,
          "sourceStageId",
          "condition",
          "targetStageId",
        ]) &&
        ["sourceStageId", "condition", "targetStageId"].every((key) =>
          text(value[key]),
        )
      );
    case "nonGates":
      return (
        fields(value, [...itemFields, "stageId", "reason"]) &&
        text(value["stageId"]) &&
        label(value["reason"], activities.slice(1))
      );
    default:
      return fields(value, itemFields);
  }
}

function inspectItem(
  value: unknown,
  context: { ids: Set<string>; collection: string; codes: Set<AnalysisCode> },
): void {
  const { ids, collection, codes } = context;
  if (!analysisObject(value)) {
    codes.add("invalid-shape");
    return;
  }
  const id = value["id"];
  if (!text(id)) {
    codes.add("invalid-shape");
    return;
  }
  if (!text(value["description"]) || ids.has(id)) codes.add("invalid-shape");
  ids.add(id);
  if (!itemShape(value, { collection, codes })) codes.add("invalid-shape");
}

function inspectItems(
  process: Record<string, unknown>,
  codes: Set<AnalysisCode>,
): void {
  const id = process["id"];
  if (!text(id)) {
    codes.add("invalid-shape");
    return;
  }
  const ids = new Set<string>([id]);
  for (const collection of collections) {
    const items = process[collection];
    if (!Array.isArray(items)) {
      codes.add("invalid-shape");
      continue;
    }
    if (
      ["stages", "stoppingConditions"].includes(collection) &&
      items.length === 0
    )
      codes.add("invalid-shape");
    for (const item of items) {
      inspectItem(item, { ids, collection, codes });
    }
  }
}

export function inspectAnalysisShape(
  value: unknown,
  codes: Set<AnalysisCode>,
): value is AnalysisCandidate {
  if (!analysisObject(value)) {
    codes.add("invalid-shape");
    return false;
  }
  if (value["schemaVersion"] !== 1) codes.add("unknown-version");
  if (!fields(value, ["schemaVersion", "process", "openQuestion"]))
    codes.add("invalid-shape");
  const validQuestion = inspectQuestionShape(value, codes);
  const process = value["process"];
  if (!analysisObject(process)) {
    codes.add("invalid-shape");
    return false;
  }
  if (
    !fields(process, ["id", "name", "scope", ...collections]) ||
    !["id", "name", "scope"].every((key) => text(process[key]))
  )
    codes.add("invalid-shape");
  inspectItems(process, codes);
  return (
    validQuestion &&
    !codes.has("invalid-shape") &&
    !codes.has("unknown-version")
  );
}
