import { servicePrelude } from "./world-host-fixture.ts";

export const decisionWorkflow = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";

export async function gateSettings() {
  "use step";
  return existsSync("gate-settings") ? JSON.parse(readFileSync("gate-settings", "utf8")) : {};
}

export async function recordDecision(decision: { decision: string; answer: string | null }) {
  "use step";
  appendFileSync("decisions", JSON.stringify(decision) + "\\n");
}

export async function develop(input: { cycleId: string }) {
  "use workflow";
  const settings = await gateSettings();
  const decision = await waitForDecision({ gateId: "review-1", kind: "approval", prompt: "Approve this change?", ...settings });
  await recordDecision(decision);
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: decision.decision, decision };
}
`;

export const mixedDecisionWorkflow = decisionWorkflow
  .replace(
    "import { waitForDecision }",
    'import { decisionGate } from "cloving/workflows/steps/decision-gate";\nimport { waitForDecision }',
  )
  .replace(
    "input: { cycleId: string })",
    "input: { cycleId: string }, continuation?: { decision: string })",
  )
  .replace(
    "  const settings = await gateSettings();",
    `
  if (continuation === undefined) {
    await decisionGate({ gateId: "legacy", kind: "approval", prompt: "Continue?" });
    return { kind: "waiting_for_decision", cycleId: input.cycleId, decisionId: "legacy" };
  }
  const settings = await gateSettings();`,
  );

export const decisionPrelude = `${servicePrelude}
import assert from "node:assert/strict";
const pendingGate = async (runId) => {
  await until(async () => ["waiting_gate", "failed"].includes(await stateOf(runId)));
  assert.equal(await stateOf(runId), "waiting_gate");
  return (await asked("questions", { runId })).decisions[0];
};
const decide = async (runId, command = "approve", overrides = {}) => {
  const gate = await pendingGate(runId);
  return await asked("decision", { command, reference: gate.decisionId, subjectDigest: gate.subjectDigest, expectedRevision: gate.revision, generation: gate.generation, commandId: command + ":" + runId, ...overrides });
};
const sdkRun = async (runId) => {
  const found = (await tagged()).filter((run) => run.run === runId);
  assert.equal(found.length, 1);
  assert.equal(JSON.parse(found[0].operation)[4], "start-run");
  return found[0].receipt;
};
const sdkEvents = async (runId) => (await (await getWorld()).events.list({ runId: await sdkRun(runId), resolveData: "none" })).data;
const hookReady = async (runId) => until(async () => (await sdkEvents(runId)).some((event) => event.eventType === "hook_created"));
const verified = async (runId, expected = { decision: "approved", answer: null }) => {
  await until(async () => (await stateOf(runId)) === "completed");
  const receipt = await sdkRun(runId);
  const output = await getRun(receipt).returnValue;
  assert.deepEqual(output.decision, expected);
  const events = await sdkEvents(runId);
  assert.equal(events.filter((event) => event.eventType === "hook_created").length, 1);
  assert.equal(events.filter((event) => event.eventType === "hook_received").length, 1);
  assert.equal((await eventTypes(runId)).filter((type) => type === "gate.opened").length, 1);
  assert.equal((await ports.state()).intents.some((intent) => intent.kind === "continue-run"), false);
  return receipt;
};
const decisions = () => lines("decisions").map(JSON.parse);
`;
