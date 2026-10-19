import type {
  CandidateAnalysis,
  CandidateDeclaration,
  InstalledWorkflowExports,
} from "../src/workflow-candidate.ts";

export const candidateDeclaration: CandidateDeclaration = {
  workflow: {
    workflowId: "candidate",
    effectLimit: 1,
    capabilities: ["claude"],
    input: { maximumBytes: 1024, fields: {} },
  },
  methods: { claude: ["run-turn"] },
};

export const installedWorkflowExports: InstalledWorkflowExports = {
  "cloving/workflows": [
    "loadCycle",
    "protectedEffect",
    "decisionGate",
    "ProtectedRequest",
    "ProtectedResult",
  ],
  "cloving/workflows/steps/load-cycle": ["loadCycle", "CycleLoad"],
  "cloving/workflows/steps/protected-effect": ["protectedEffect"],
  "cloving/workflows/steps/decision-gate": ["decisionGate"],
};

export const combinedCandidateSource = `
import { generateWorkflow, protectedEffect } from "cloving/workflows";
export async function candidate() {
  "use workflow";
  return await protectedEffect({
    scope: { phase: "work", operation: "effect", round: 1 },
    capability: "github",
    method: "create-pull-request",
    target: "synthetic",
    payload: "synthetic",
    units: 1,
  });
}
`;

export const combinedCandidateAnalysis: CandidateAnalysis = {
  imports: [
    {
      module: "cloving/workflows",
      names: ["generateWorkflow", "protectedEffect"],
    },
  ],
  effects: [{ capability: "github", method: "create-pull-request" }],
  directEffects: [],
  unsupportedForms: [],
  knownCallCount: 1,
  knownUnitTotal: 1,
};

export const validCandidateSource = combinedCandidateSource
  .replace("generateWorkflow, ", "")
  .replace('"cloving/workflows"', '"cloving/workflows/steps/protected-effect"')
  .replace('capability: "github"', 'capability: "claude"')
  .replace('method: "create-pull-request"', 'method: "run-turn"');

export function candidateSource(body: string): string {
  return `import { protectedEffect } from "cloving/workflows";
export async function candidate(input: { capability: string; method: string; units: number }) {
  "use workflow";
  ${body}
}`;
}

export const candidateEffectExpression = `protectedEffect({
  scope: { phase: "work", operation: "effect", round: 1 },
  capability: "claude", method: "run-turn", target: "synthetic", payload: "synthetic", units: 1
})`;

export const unsupportedCandidateSources = {
  "dynamic-loading": candidateSource('await import("cloving/workflows");'),
  "commonjs-loading": candidateSource('const load = require; load("fs");'),
  "re-export": `${validCandidateSource}\nexport { loadCycle } from "cloving/workflows";`,
  "namespace-import": `${validCandidateSource}\nimport * as helpers from "cloving/workflows";`,
  "default-import": `${validCandidateSource}\nimport helpers from "cloving/workflows";`,
  "side-effect-import": `${validCandidateSource}\nimport "cloving/workflows";`,
  spread: candidateSource(
    `await ${candidateEffectExpression.replace("scope:", "...{}, scope:")};`,
  ),
  "helper-reassignment": candidateSource("protectedEffect = async () => null;"),
  "helper-escape": candidateSource("const invoke = protectedEffect;"),
  "indirect-protected-call": candidateSource(
    `await ${candidateEffectExpression.replace("protectedEffect", "(protectedEffect)")};`,
  ),
  "candidate-step": `${validCandidateSource}\nasync function hidden() { "use step"; return 1; }`,
  "computed-access": candidateSource("return input[input.method];"),
  "ambient-declaration": `${validCandidateSource}\ndeclare const ambient: string;`,
  "ambient-reference": `/// <reference path="./ambient.d.ts" />\n${validCandidateSource}`,
  "missing-workflow": "export async function candidate() { return 1; }",
  "second-workflow": `${validCandidateSource}\nexport async function other() { "use workflow"; return 1; }`,
  "non-async-workflow":
    'export function candidate() { "use workflow"; return 1; }',
  "unexported-workflow":
    'async function candidate() { "use workflow"; return 1; }',
  "object-indirection": candidateSource(
    "const request = {}; await protectedEffect(request);",
  ),
};

export const validCandidateAnalysis: CandidateAnalysis = {
  ...combinedCandidateAnalysis,
  imports: [
    {
      module: "cloving/workflows/steps/protected-effect",
      names: ["protectedEffect"],
    },
  ],
  effects: [{ capability: "claude", method: "run-turn" }],
};

export const invalidCandidateDeclarations: readonly unknown[] = [
  null,
  [],
  {},
  candidateDeclaration.workflow,
  { ...candidateDeclaration, extra: true },
  { ...candidateDeclaration, workflow: null },
  {
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, workflowId: "../candidate" },
  },
  {
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, effectLimit: 0 },
  },
  {
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, effectLimit: 101 },
  },
  {
    ...candidateDeclaration,
    workflow: {
      ...candidateDeclaration.workflow,
      capabilities: ["fake-harness"],
    },
  },
  {
    ...candidateDeclaration,
    workflow: { ...candidateDeclaration.workflow, input: {} },
  },
  { workflow: candidateDeclaration.workflow },
  { ...candidateDeclaration, methods: null },
  { ...candidateDeclaration, methods: [] },
  { ...candidateDeclaration, methods: {} },
  { ...candidateDeclaration, methods: { claude: [] } },
  { ...candidateDeclaration, methods: { claude: "run-turn" } },
  { ...candidateDeclaration, methods: { claude: [null] } },
  { ...candidateDeclaration, methods: { claude: [1] } },
  { ...candidateDeclaration, methods: { claude: [""] } },
  { ...candidateDeclaration, methods: { claude: ["   "] } },
  { ...candidateDeclaration, methods: { claude: ["run-turn", "run-turn"] } },
  {
    ...candidateDeclaration,
    methods: { claude: ["run-turn"], github: ["create-pull-request"] },
  },
  {
    ...candidateDeclaration,
    methods: { claude: ["run-turn"], unknown: ["run-turn"] },
  },
];

export const forbiddenCandidateModules = [
  "./helper.ts",
  "../helper.ts",
  "/candidate/helper.ts",
  "~/helper.ts",
  "node:fs",
  "fs",
  "node:child_process",
  "another-package",
  "@scope/package",
  "cloving",
  "cloving/workflows/internal",
  "file:///candidate/helper.ts",
  "https://example.invalid/helper.ts",
  "C:\\candidate\\helper.ts",
  "__proto__",
  "constructor",
];

export const directEffectCategories = [
  "process",
  "file",
  "network",
  "waiting-timer",
  "environment",
  "dynamic-evaluation",
];

export const unsupportedCandidateForms = [
  "dynamic-loading",
  "re-export",
  "non-named-import",
  "spread",
  "helper-reassignment",
  "indirect-protected-call",
  "candidate-step",
  "computed-access",
  "ambient-declaration",
  "workflow-shape",
];
