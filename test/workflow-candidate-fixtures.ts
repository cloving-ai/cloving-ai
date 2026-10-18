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
