import { record } from "../src/protocol.ts";
import type {
  CandidateAnalysis,
  CandidateEffect,
  CandidateFunctionAnalysis,
  CandidateImport,
  InstalledWorkflowExports,
} from "../src/workflow-candidate.ts";

export interface CandidateFacts {
  readonly analysis: CandidateAnalysis;
  readonly installedExports: InstalledWorkflowExports;
}

function fields(value: unknown, names: readonly string[]) {
  const entry = record(value);
  return entry && Object.keys(entry).every((name) => names.includes(name))
    ? entry
    : undefined;
}

function strings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function effect(value: unknown): value is CandidateEffect {
  const entry = fields(value, ["capability", "method"]);
  return (
    entry !== undefined &&
    nullableString(entry["capability"]) &&
    nullableString(entry["method"])
  );
}

function imported(value: unknown): value is CandidateImport {
  const entry = fields(value, ["module", "names", "source"]);
  return (
    entry !== undefined &&
    typeof entry["module"] === "string" &&
    strings(entry["names"]) &&
    (!Object.hasOwn(entry, "source") || typeof entry["source"] === "string")
  );
}

function totals(entry: Readonly<Record<string, unknown>>): boolean {
  return (
    ["knownCallCount", "knownUnitTotal"].every((name) => {
      const value = entry[name];
      return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      );
    }) &&
    Array.isArray(entry["effects"]) &&
    entry["effects"].every(effect) &&
    strings(entry["unsupportedForms"])
  );
}

const totalFields = [
  "effects",
  "unsupportedForms",
  "knownCallCount",
  "knownUnitTotal",
];

function workflow(value: unknown): value is CandidateFunctionAnalysis {
  const entry = fields(value, totalFields);
  return entry !== undefined && totals(entry);
}

function optionalField(
  input: {
    readonly entry: Readonly<Record<string, unknown>>;
    readonly name: string;
  },
  check: (value: unknown) => boolean,
): boolean {
  return (
    !Object.hasOwn(input.entry, input.name) || check(input.entry[input.name])
  );
}

function commandWaits(value: unknown): boolean {
  return Array.isArray(value) && value.every(nullableString);
}

function workflowFacts(value: unknown): boolean {
  const entries = record(value);
  return entries !== undefined && Object.values(entries).every(workflow);
}

function analysis(value: unknown): value is CandidateAnalysis {
  const entry = fields(value, [
    ...totalFields,
    "workflows",
    "commandWaits",
    "localSources",
    "imports",
    "directEffects",
  ]);
  if (!entry || !totals(entry)) return false;
  if (!strings(entry["directEffects"])) return false;
  if (!Array.isArray(entry["imports"]) || !entry["imports"].every(imported))
    return false;
  return (
    optionalField({ entry, name: "localSources" }, strings) &&
    optionalField({ entry, name: "commandWaits" }, commandWaits) &&
    optionalField({ entry, name: "workflows" }, workflowFacts)
  );
}

export function isCandidateFacts(value: unknown): value is CandidateFacts {
  const entry = fields(value, ["analysis", "installedExports"]);
  if (!entry || !analysis(entry["analysis"])) return false;
  const installed = record(entry["installedExports"]);
  return installed !== undefined && Object.values(installed).every(strings);
}
