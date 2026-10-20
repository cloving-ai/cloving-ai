import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidate, questionCandidate } from "./chats-analysis-fixture.ts";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import { field } from "./develop-workflow-fixture.ts";
import {
  productRoot,
  servicePrelude,
  withConsumer,
} from "./world-host-fixture.ts";
import { pathToFileURL } from "node:url";

const source = readFileSync(
  join(productRoot, "workflows/analyze-chats.ts"),
  "utf8",
);
const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(join(productRoot, name)).href);
const injection =
  "/synthetic/notes.txt C:\\synthetic\\notes.txt operator@example.invalid @synthetic /question\\w+/g";
const draftCandidate = questionCandidate();
draftCandidate.openQuestion.description = injection;
const setup = `
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
const privateChats = chatsWorker({ runtimeDirectory, document, workflowId });
const chats = {
  ...privateChats,
  deliver: async (intent, signal) => {
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
const service = await hosted({ registrations: [registration], workflow: workflows.analyzeChats, destination: destinationAnalysis, effects: { leaseMilliseconds: testMilliseconds(1000) } });
const submitAnalysis = async () => (await asked("run", { workflowId: "analyze-chats", source: "input", submission: { importId }, commandId: "analysis-command" })).runId;
const finished = async (runId) => {
  await until(async () => ["completed", "blocked", "failed"].includes(await stateOf(runId))).catch(async (error) => { print({ diagnostic: (await asked("status", { runId })).run, requests: lines("requests.log"), worlds: await tagged() }); throw error; });
  const status = await asked("status", { runId });
  const events = await asked("events", { runId, after: 0, limit: 1000 });
  const outputs = readdirSync(directory).filter((name) => name.startsWith("analysis-") || name.startsWith("proposal-"));
  const drafts = readdirSync(directory).filter((name) => name.startsWith("draft-"));
  const draft = drafts.length === 1 ? JSON.parse(readFileSync(directory + "/" + drafts[0], "utf8")) : undefined;
  print({ drafts: drafts.length, expiresAt: draft?.expiresAt, candidateDigest: draft?.candidateDigest, state: status.run.state, budget: status.run.budget, usage: status.run.usage, usageTurns: status.run.workerTurns.length, cost: status.run.claudeCostUsd, outcome: status.run.outcome, outputs, turns: lines("turns.log").length, safe: ![${JSON.stringify(injection)}, "/synthetic/notes.txt", "operator@example.invalid", "@synthetic", "Bounded review and repair", "At most three review and repair rounds."].some((text) => JSON.stringify({ status, events }).includes(JSON.stringify(text).slice(1, -1))) });
  await service.close();
  await analysis.close();
  await chats.close();
};
`;

await test(
  "CLV-116 compiled Local World replay reuses a durable completed private reply before report delivery and saves once",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "completed-private-result",
        `writeFileSync("halt-before-report", "");${setup}
print({ runId: await submitAnalysis() });
`,
      );
      assert.equal(
        field(first.lines[1], "boundary"),
        "completed-private-result",
        first.stderr,
      );
      const runId = String(field(first.lines[0], "runId"));
      const second = await consumer.run(
        `rmSync("halt-before-report");${setup}
await finished(process.env.RUN_ID);
`,
        { RUN_ID: runId },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      const line = second.lines[0];
      assert.equal(
        field(line, "state"),
        "completed",
        JSON.stringify(second.lines),
      );
      assert.deepEqual(field(line, "budget"), { limit: 3, spent: 3 });
      assert.equal(field(line, "turns"), 1);
      assert.equal(field(line, "usageTurns"), 1);
      assert.equal(field(line, "cost"), 0.25);
      assert.deepEqual(field(line, "usage"), {
        input_tokens: 1500,
        cache_read_input_tokens: 800,
        output_tokens: 150,
      });
      assert.equal(field(line, "safe"), true);
      assert.equal(field(field(line, "outputs"), "length"), 2);
    }),
  ),
);

await test(
  "CLV-116 compiled Local World interruption blocks and never launches a replacement turn",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "interrupted-turn",
        `writeFileSync("interrupt", "");${setup}
const runId = await submitAnalysis();
await until(() => lines("turns.log").length === 1);
const turn = JSON.parse(lines("turns.log")[0]);
process.kill(turn.processId, "SIGKILL");
await until(() => !existsSync("worktrees"));
await halt("interrupted-turn", { runId });
`,
      );
      assert.equal(
        field(first.lines[0], "boundary"),
        "interrupted-turn",
        first.stderr,
      );
      const second = await consumer.run(
        `${setup}
await finished(process.env.RUN_ID);
`,
        { RUN_ID: String(field(first.lines[0], "runId")) },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      assert.equal(field(second.lines[0], "state"), "completed");
      assert.deepEqual(field(second.lines[0], "outcome"), {
        kind: "blocked",
        reason: "analysis-turn-failed",
      });
      assert.equal(field(second.lines[0], "turns"), 1);
      assert.deepEqual(field(second.lines[0], "budget"), {
        limit: 3,
        spent: 2,
      });
      assert.equal(field(field(second.lines[0], "outputs"), "length"), 0);
    }),
  ),
);

await test(
  "CLV-117 compiled Local World recovers a saved private draft before delivery reporting without finalizing",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "saved-private-draft",
        `writeFileSync("draft-question", ""); writeFileSync("halt-after-draft", "");${setup}
print({ runId: await submitAnalysis() });`,
      );
      const boundary = first.lines[1];
      assert.equal(
        field(boundary, "boundary"),
        "saved-private-draft",
        first.stderr,
      );
      const second = await consumer.run(
        `rmSync("halt-after-draft");${setup}
await finished(process.env.RUN_ID);`,
        { RUN_ID: String(field(first.lines[0], "runId")) },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      const line = second.lines[0];
      assert.equal(field(line, "drafts"), 1);
      assert.equal(field(line, "expiresAt"), field(boundary, "expiresAt"));
      assert.equal(
        field(line, "candidateDigest"),
        field(boundary, "candidateDigest"),
      );
      assert.deepEqual(field(line, "outcome"), {
        kind: "blocked",
        reason: "analysis-input-refused",
      });
      assert.deepEqual(field(line, "budget"), { limit: 3, spent: 3 });
      assert.equal(field(line, "turns"), 1);
      assert.equal(field(line, "usageTurns"), 1);
      assert.equal(field(line, "safe"), true);
      assert.deepEqual(field(line, "outputs"), []);
    }),
  ),
);
