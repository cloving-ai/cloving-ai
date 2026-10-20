import { generateWorkflow } from "../src/chats/workflow-generation.ts";
import {
  acceptedAnalysis,
  generationAvailability,
} from "./chats-workflow-generation-fixture.ts";
import { servicePrelude } from "./world-host-fixture.ts";
import { candidate, itemAt } from "./chats-analysis-fixture.ts";
import assert from "node:assert/strict";

export function generatedArtifact(gateType = "design-decision") {
  const input = candidate();
  if (gateType === "no-gates") input.process.gates = [];
  else itemAt(input.process.gates).type = gateType;
  const generated = generateWorkflow(
    acceptedAnalysis(input),
    generationAvailability,
  );
  assert.equal(generated.kind, "generated");
  return generated.artifact;
}

export function generatedPrelude(gateType = "design-decision"): string {
  const artifact = generatedArtifact(gateType);
  return (
    servicePrelude
      .replace(
        'result: "effect-result"',
        "result: generatedResult(operationId)",
      )
      .replace(
        'appendFileSync("destination.log", intent.operationId + "\\n");',
        'appendFileSync("payloads.log", await ports.document(intent.payload) + "\\n"); appendFileSync("destination.log", intent.operationId + "\\n");',
      ) +
    `
const generatedResult = (operationId) => {
  if (process.env.MODE === "malformed") return JSON.stringify({ summary: "missing status" });
  if (process.env.MODE === "missing") return JSON.stringify({ summary: "{}" });
  if (process.env.MODE === "unknown") return JSON.stringify({ summary: JSON.stringify({ status: "unrecognized" }) });
  const index = lines("destination.log").indexOf(operationId);
  const status = process.env.MODE === "exhaust" || index === 0 ? "repair" : "complete";
  return JSON.stringify({ summary: JSON.stringify({ status }) });
};
const declaration = ${JSON.stringify(artifact.declaration.workflow)};
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["claude"] };
registration.effectLimit = declaration.effectLimit;
registration.submission = declaration.input;
registration.resolver = { id: "generated-fixture", version: "1", resolve: async (request) => ({ kind: "resolved", input: { cycleId: "cycle-1", repository: "synthetic-current-workspace", input: request.submission } }) };
const openGenerated = (overrides = {}) => hosted({ registrations: [registration], workflow: workflows.clvFunction1, ...overrides });
const submitGenerated = async () => { const reply = await asked("run", { workflowId: "develop", source: "input", submission: { clvInput1: "synthetic-current-task" }, commandId: "c-generated" }); if (reply.runId === undefined) throw new Error(JSON.stringify(reply)); return reply.runId; };
const terminal = async (runId) => { await until(async () => ["waiting_gate", "completed", "blocked"].includes(await stateOf(runId))); await until(async () => (await tagged()).every((run) => run.status === "completed")); };
const generatedState = async (runId) => {
  const run = (await asked("status", { runId })).run;
  return { state: run.state, budget: run.budget, effects: run.effects.length, sends: lines("destination.log").length, gates: (await asked("questions", { runId })).decisions.map((gate) => [gate.type, gate.gateId]), segments: await segments() };
};
`
  );
}
