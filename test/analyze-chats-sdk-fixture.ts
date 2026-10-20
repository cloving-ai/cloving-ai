import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { candidate, questionCandidate } from "./chats-analysis-fixture.ts";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import { productRoot, servicePrelude } from "./world-host-fixture.ts";

export const analysisSource = readFileSync(
  join(productRoot, "workflows/analyze-chats.ts"),
  "utf8",
);
const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(join(productRoot, name)).href);
const injection =
  "/synthetic/notes.txt C:\\synthetic\\notes.txt operator@example.invalid @synthetic /question\\w+/g";
const draftCandidate = questionCandidate();
draftCandidate.openQuestion.description = injection;
export const analysisSetup = `
${servicePrelude}
import { claudeWorker } from ${moduleUrl("src/daemon/claude-worker.ts")};
import { chatsWorker } from ${moduleUrl("src/daemon/chats-worker.ts")};
import { installAnalysisCli } from ${moduleUrl("test/claude-worker-fixture.ts")};
const importId = ${JSON.stringify(importId)};
const directory = runtimeDirectory + "/chats/" + importId;
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (!existsSync(directory + "/redaction.json")) {
  writeFileSync(directory + "/redaction.json", ${JSON.stringify(JSON.stringify(manifest))}, { mode: 0o600 });
  writeFileSync(directory + "/redacted.jsonl", ${JSON.stringify(corpus)}, { mode: 0o600 });
  writeFileSync(directory + "/structure.json", ${JSON.stringify(JSON.stringify(sidecar))}, { mode: 0o600 });
}
writeFileSync("turns.log", existsSync("turns.log") ? readFileSync("turns.log") : "");
installAnalysisCli({ directory: process.cwd() }, { reply: existsSync("draft-question") ? ${JSON.stringify(JSON.stringify(draftCandidate))} : ${JSON.stringify(JSON.stringify(candidate()))}, mode: existsSync("interrupt") ? "hold" : "fixed-reply" });
let analysisNow = "2026-10-20T10:00:00.000Z";
const analysisClock = () => existsSync("clock-analysis") ? analysisNow : new Date().toISOString();
const document = async (digest) => ports.document(digest);
const workflowId = async (runId) => ports.workflowId(runId);
const analysis = claudeWorker({
  worker: "codex", command: ["false"], repository: "unused", worktrees: process.cwd() + "/worktrees", journal: process.cwd() + "/journal", document, workflowId,
  report: async (report) => {
    if (existsSync("halt-before-report")) {
      writeFileSync(directory + "/redacted.jsonl", "changed after capture");
      await halt("completed-private-result");
    }
    return ports.reportEffect(report);
  },
});
const privateChats = chatsWorker({ runtimeDirectory, document, workflowId, now: analysisClock });
const chats = {
  ...privateChats,
  deliver: async (intent, signal) => {
    if (intent.method === "read-analysis") await holdAt("hold-analysis-read");
    const outcome = await privateChats.deliver(intent, signal);
    if (intent.method === "save-analysis" && outcome.kind === "completed" && existsSync("halt-after-draft")) {
      writeFileSync(directory + "/redacted.jsonl", "changed after draft save");
      const metadata = JSON.parse(outcome.result);
      await halt("saved-private-draft", { expiresAt: metadata.expiresAt, candidateDigest: metadata.candidateDigest });
    }
    return outcome;
  },
};
const routed = (intent) => intent.capability === "chats" ? chats : analysis;
const destinationAnalysis = {
  deliver: (intent, signal) => routed(intent).deliver(intent, signal),
  reconcile: (intent, signal) => routed(intent).reconcile(intent, signal),
  stop: (intent, signal) => routed(intent).stop(intent, signal),
};
const fake = fakeRegistration([]);
const registration = {
  ...fake, workflowId: "analyze-chats", effectLimit: 3,
  manifest: { ...fake.manifest, capabilities: ["chats", "claude"] },
  submission: { maximumBytes: 4096, fields: { importId: "string" } },
  resolver: { id: "analysis-fixture", version: "1", resolve: () => Promise.resolve({ kind: "resolved", input: { cycleId: "analysis-cycle", repository: "unused", input: { importId } } }) },
};
const service = await hosted({ clock: analysisClock, registrations: [registration], workflow: workflows.analyzeChats, destination: destinationAnalysis, effects: { leaseMilliseconds: testMilliseconds(1000) } });
const submitAnalysis = async () => (await asked("run", { workflowId: "analyze-chats", source: "input", submission: { importId }, commandId: "analysis-command" })).runId;
const finished = async (runId) => {
  await until(async () => ["completed", "blocked", "failed", "waiting_gate"].includes(await stateOf(runId))).catch(async (error) => { print({ diagnostic: (await asked("status", { runId })).run, requests: lines("requests.log"), worlds: await tagged() }); throw error; });
  await until(async () => (await tagged()).every((run) => run.status === "completed"));
  const status = await asked("status", { runId });
  const events = await asked("events", { runId, after: 0, limit: 1000 });
  const outputs = readdirSync(directory).filter((name) => name.startsWith("analysis-") || name.startsWith("proposal-"));
  const drafts = readdirSync(directory).filter((name) => name.startsWith("draft-"));
  const draft = drafts.length === 1 ? JSON.parse(readFileSync(directory + "/" + drafts[0], "utf8")) : undefined;
  const gates = Object.values((await ports.state()).gates).filter((gate) => gate.runId === runId);
  const gate = gates[0];
  const prompt = gate ? await ports.document(gate.prompt) : undefined;
  print({ gates: gates.length, expiresMatch: gate?.expiresAt === draft?.expiresAt, candidateBound: prompt ? JSON.parse(prompt).candidateDigest === draft?.candidateDigest && digestOf(prompt) === gate.subject : undefined, drafts: drafts.length, expiresAt: draft?.expiresAt, candidateDigest: draft?.candidateDigest, state: status.run.state, budget: status.run.budget, usage: status.run.usage, usageTurns: status.run.workerTurns.length, cost: status.run.claudeCostUsd, outcome: status.run.outcome, outputs, turns: lines("turns.log").length, safe: ![${JSON.stringify(injection)}, "/synthetic/notes.txt", "operator@example.invalid", "@synthetic", "Bounded review and repair", "At most three review and repair rounds."].some((text) => JSON.stringify({ status, events }).includes(JSON.stringify(text).slice(1, -1))) });
  await service.close();
  await analysis.close();
  await chats.close();
};
`;

export const analysisQuestionSetup = `
writeFileSync("draft-question", "");
writeFileSync("clock-analysis", "");
${analysisSetup}
writeFileSync("hold-analysis-read", "");
const runId = await submitAnalysis();
await until(() => existsSync("hold-analysis-read-entered"));
const early = await asked("decision", { command: "answer", reference: runId + "/analysis-question", text: "earlier", subjectDigest: digestOf("not-yet-available"), expectedRevision: 1, generation: 1, commandId: "early-answer" });
rmSync("hold-analysis-read");
await until(async () => ["waiting_gate", "completed"].includes(await stateOf(runId)));
const [question] = (await asked("questions", { runId })).decisions;
if (!question) throw new Error("analysis-question-not-opened");
const { watchedModel } = await import(${moduleUrl("test/watch-fixture.ts")});
const pendingView = await watchedModel(runtimeDirectory);
const operationalSafe = !JSON.stringify(pendingView).includes("operator@example.invalid");
const privateQuestionRetained = question.prompt.includes("operator@example.invalid");
const answer = (text, overrides = {}) => asked("decision", {
  command: "answer", reference: question.decisionId, text,
  expectedRevision: question.revision, generation: question.generation,
  subjectDigest: question.subjectDigest, commandId: "analysis-answer", ...overrides,
});
`;
