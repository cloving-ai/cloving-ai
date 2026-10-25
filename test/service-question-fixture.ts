import { servicePrelude } from "./world-host-fixture.ts";

export const questionSource = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
export async function develop(input, decision) {
  "use workflow";
  const prepared = await protectedEffect({ scope: { phase: "work", operation: "prepare", round: 1 }, capability: "fake-harness", method: "run-turn", target: "fixture", payload: "prepare question", units: 1 });
  if (prepared.kind !== "completed") return { kind: "blocked", cycleId: input.cycleId, reason: prepared.reason };
  if (!decision) {
    const gate = await decisionGate({ gateId: "design-choice", kind: "question", prompt: "Choose a parser: earlier or later.", expiresAt: "2026-10-21T10:00:00.000Z" });
    return gate.kind === "opened" ? { kind: "waiting_for_decision", cycleId: input.cycleId, decisionId: gate.decisionId } : { kind: "blocked", cycleId: input.cycleId, reason: gate.reason };
  }
  if (decision.decision === "expired") return { kind: "blocked", cycleId: input.cycleId, reason: "answer-missing" };
  if (decision.gateId !== "design-choice" || decision.decision !== "answered" || decision.answer !== "earlier") return { kind: "blocked", cycleId: input.cycleId, reason: "answer-invalid" };
  const finished = await protectedEffect({ scope: { phase: "work", operation: "finish", round: 1 }, capability: "fake-harness", method: "run-turn", target: "fixture", payload: decision.answer, units: 1 });
  return { kind: finished.kind === "completed" ? "handoff_requested" : "blocked", cycleId: input.cycleId };
}
`;

export const questionSetup = `
${servicePrelude}
let questionNow = "2026-10-20T10:00:00.000Z";
const service = await hosted({
  clock: () => questionNow,
  workflow: workflows.develop,
  destination: { ...destination, deliver: async (intent, signal) => {
    await holdAt("hold-question-read");
    return destination.deliver(intent, signal);
  } },
});
writeFileSync("hold-question-read", "");
const runId = await submitted("question-command");
await until(() => existsSync("hold-question-read-entered"));
const early = await asked("decision", { command: "answer", reference: runId + "/design-choice", text: "earlier", subjectDigest: digestOf("not-yet-available"), expectedRevision: 1, generation: 1, commandId: "early-answer" });
rmSync("hold-question-read");
await until(async () => await stateOf(runId) === "waiting_gate");
const [question] = (await asked("questions", { runId })).decisions;
if (!question) throw new Error("question-not-opened");
const answer = (text, overrides = {}) => asked("decision", {
  command: "answer", reference: question.decisionId, text,
  expectedRevision: question.revision, generation: question.generation,
  subjectDigest: question.subjectDigest, commandId: "question-answer", ...overrides,
});
const finished = async (runId) => {
  await until(async () => ["completed", "blocked", "failed"].includes(await stateOf(runId)));
  const status = await asked("status", { runId });
  const gates = Object.values((await ports.state()).gates).filter((gate) => gate.runId === runId);
  print({ state: status.run.state, budget: status.run.budget, outcome: status.run.outcome, gates: gates.length, turns: lines("destination.log").length, deadline: gates[0]?.expiresAt });
  await service.close();
};
`;
