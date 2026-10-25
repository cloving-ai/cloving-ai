import { record } from "./protocol.ts";
import {
  isWorkflowDeclaration,
  type WorkflowDeclaration,
} from "./workflow-declaration.ts";

export interface CandidateDeclaration {
  readonly workflow: WorkflowDeclaration;
  readonly methods: Readonly<Record<string, readonly string[]>>;
}

export interface CandidateImport {
  readonly module: string;
  readonly names: readonly string[];
}

export interface CandidateEffect {
  readonly capability: string | null;
  readonly method: string | null;
}

export interface CandidateAnalysis {
  readonly imports: readonly CandidateImport[];
  readonly effects: readonly CandidateEffect[];
  readonly directEffects: readonly string[];
  readonly unsupportedForms: readonly string[];
  readonly knownCallCount: number;
  readonly knownUnitTotal: number;
}

export type InstalledWorkflowExports = Readonly<
  Record<string, readonly string[]>
>;

export type WorkflowCandidateCode =
  | "invalid-declaration"
  | "forbidden-import"
  | "missing-export"
  | "unsupported-source"
  | "dynamic-effect"
  | "undeclared-effect"
  | "effect-limit"
  | "direct-effect";

export interface WorkflowCandidateInput {
  readonly declaration: unknown;
  readonly analysis: CandidateAnalysis;
  readonly installedExports: InstalledWorkflowExports;
}

const workflowModules = [
  "cloving/workflows",
  "cloving/workflows/steps/decision-gate",
  "cloving/workflows/steps/load-cycle",
  "cloving/workflows/steps/protected-effect",
  "cloving/workflows/steps/handoff",
  "cloving/workflows/steps/run-command",
];

function isMethodList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.from(value).every(
      (method: unknown) =>
        typeof method === "string" && method.trim().length > 0,
    ) &&
    new Set(value).size === value.length
  );
}

function isCandidateDeclaration(value: unknown): value is CandidateDeclaration {
  const fields = record(value);
  if (
    !fields ||
    Object.keys(fields).some((key) => key !== "workflow" && key !== "methods")
  )
    return false;
  const workflow = fields["workflow"];
  const methods = record(fields["methods"]);
  if (!isWorkflowDeclaration(workflow) || !methods) return false;
  const capabilities: readonly string[] = workflow.capabilities;
  return (
    Object.keys(methods).every((key) => capabilities.includes(key)) &&
    capabilities.every((capability) => isMethodList(methods[capability]))
  );
}

export function checkWorkflowCandidate(
  input: WorkflowCandidateInput,
): readonly WorkflowCandidateCode[] {
  if (!isCandidateDeclaration(input.declaration))
    return ["invalid-declaration"];
  const { analysis, declaration, installedExports } = input;
  const codes: WorkflowCandidateCode[] = [];
  if (analysis.imports.some((entry) => !workflowModules.includes(entry.module)))
    codes.push("forbidden-import");
  if (
    analysis.imports.some((entry) => {
      if (!workflowModules.includes(entry.module)) return false;
      const names = installedExports[entry.module];
      return (
        names === undefined || entry.names.some((name) => !names.includes(name))
      );
    })
  )
    codes.push("missing-export");
  if (
    analysis.effects.some(
      (effect) =>
        effect.capability !== null &&
        effect.method !== null &&
        (!Object.hasOwn(declaration.methods, effect.capability) ||
          !declaration.methods[effect.capability]?.includes(effect.method)),
    )
  )
    codes.push("undeclared-effect");
  if (
    analysis.effects.some(
      (effect) => effect.capability === null || effect.method === null,
    )
  )
    codes.push("dynamic-effect");
  const counts = [analysis.knownCallCount, analysis.knownUnitTotal];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0))
    codes.push("unsupported-source");
  else if (counts.some((count) => count > declaration.workflow.effectLimit))
    codes.push("effect-limit");
  if (analysis.directEffects.length > 0) codes.push("direct-effect");
  if (analysis.unsupportedForms.length > 0) codes.push("unsupported-source");
  return [...new Set(codes)].sort();
}
