import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeWorkflowCandidate } from "../tools/workflow-candidate-source.ts";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { admitWorkflowCandidate } from "../tools/admit-workflow.ts";
import { withConsumer } from "./world-host-fixture.ts";
import {
  generatedArtifact,
  generatedPrelude,
} from "./chats-workflow-generation-sdk-fixture.ts";

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

await test("CLV-122 generated projection without human gates completes after the bounded review", () =>
  withConsumer(generatedArtifact("no-gates").source, async (consumer) => {
    const artifact = generatedArtifact("no-gates");
    assert.equal(artifact.source.includes("decisionGate({"), false);
    const result = await consumer.run(`${generatedPrelude("no-gates")}
const service = await openGenerated();
const runId = await submitGenerated();
await terminal(runId);
print(await generatedState(runId));
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(field(result.lines[0], "state"), "completed");
    assert.deepEqual(field(result.lines[0], "budget"), { limit: 6, spent: 3 });
    assert.deepEqual(field(result.lines[0], "gates"), []);
    const segments: unknown = field(result.lines[0], "segments");
    assert.ok(Array.isArray(segments));
    assert.equal(
      field(field(segments[0], "output"), "kind"),
      "handoff_requested",
    );
  }));

await test("CLV-122 malformed or oversized typed continuations are rejected before any new effect request", () =>
  withConsumer(generatedArtifact().source, async (consumer) => {
    const result = await consumer.run(`
let effectCalls = 0;
globalThis[Symbol.for("cloving.step-bridge/v1")] = { effect: async () => { effectCalls++; return { kind: "unavailable", reason: "test" }; }, gate: async () => { throw new Error("unexpected-gate"); } };
const opened = await startHost({ dataDirectory, concurrency: 1, handler: POST });
if (opened.kind !== "started") throw new Error(opened.reason);
const input = { cycleId: "cycle-1", repository: "synthetic-current-workspace", input: { clvInput1: "synthetic-current-task" } };
const invalid = [null, {}, { gateId: "other", decision: "answered", answer: "yes" }, { gateId: "clv-gate-1", decision: "approved", answer: null }, { gateId: "clv-gate-1", decision: "answered", answer: "x".repeat(8001) }];
const outcomes = [];
for (const continuation of invalid) { const run = await start(workflows.clvFunction1, [input, continuation]); outcomes.push(await getRun(run.runId).returnValue); }
print({ effectCalls, reasons: outcomes.map((outcome) => outcome.reason) });
await opened.host.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [
      {
        effectCalls: 0,
        reasons: Array.from({ length: 5 }, () => "invalid-continuation"),
      },
    ]);
  }));

await test("CLV-122 acknowledged answer survives restart before delivery and a lost continuation reply without repeated effects or spending", () =>
  withConsumer(generatedArtifact().source, async (consumer) => {
    const before = await consumer.runUntil(
      "generated-before-continuation",
      `${generatedPrelude()}
const wrap = (product) => ({ ...recording(product), deliver: async (intent) => {
  if (intent.kind === "continue-run") { await until(() => existsSync("answer-acknowledged")); return await halt("generated-before-continuation"); }
  return await product.deliver(intent);
} });
const service = await openGenerated({ wrap });
const runId = await submitGenerated();
await terminal(runId);
const [gate] = (await asked("questions", { runId })).decisions;
const reply = await asked("decision", { command: "answer", reference: gate.decisionId, text: "Use the current design.", subjectDigest: gate.subjectDigest, expectedRevision: gate.revision, generation: gate.generation, commandId: "generated-answer" });
print({ runId, answer: reply.kind });
writeFileSync("answer-acknowledged", "");
`,
    );
    const known: unknown = before.lines[0];
    assert.equal(field(known, "answer"), "decision-recorded");
    const runId = String(field(known, "runId"));
    const sent = await consumer.runUntil(
      "generated-after-continuation",
      `${generatedPrelude()}
const wrap = (product) => ({ ...recording(product), deliver: async (intent) => {
  const delivered = await product.deliver(intent);
  if (intent.kind === "continue-run") return await halt("generated-after-continuation", { segments: (await tagged()).length });
  return delivered;
} });
await openGenerated({ wrap });
`,
    );
    assert.deepEqual(sent.lines, [
      { boundary: "generated-after-continuation", segments: 2 },
    ]);
    const result = await consumer.run(`${generatedPrelude()}
const service = await openGenerated();
const runId = ${JSON.stringify(runId)};
await until(async () => (await stateOf(runId)) === "completed");
await terminal(runId);
print(await generatedState(runId));
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    const line: unknown = result.lines[0];
    assert.deepEqual(field(line, "budget"), { limit: 6, spent: 3 });
    assert.equal(field(line, "sends"), 3);
    assert.equal(field(line, "effects"), 3);
    const segments: unknown = field(line, "segments");
    assert.ok(Array.isArray(segments));
    assert.deepEqual(
      segments.map((segment: unknown) => field(segment, "kind")),
      ["start-run", "continue-run"],
    );
    assert.equal(field(segments[1], "status"), "completed");
    assert.equal(
      Reflect.get(Object(Reflect.get(Object(segments[1]), "output")), "kind"),
      "handoff_requested",
    );
  }));

for (const [mode, spent, reason] of [
  ["exhaust", 6, "repair-limit-exhausted"],
  ["malformed", 1, "worker-blocked"],
  ["missing", 1, "worker-blocked"],
  ["unknown", 1, "worker-blocked"],
] as const)
  await test(`CLV-122 generated SDK blocks ${mode} worker outcomes within the declared limit`, () =>
    withConsumer(generatedArtifact().source, async (consumer) => {
      const result = await consumer.run(
        `${generatedPrelude()}
const service = await openGenerated();
const runId = await submitGenerated();
await terminal(runId);
print(await generatedState(runId));
await service.close();
`,
        { MODE: mode },
      );
      assert.equal(result.status, 0, result.stderr);
      const line: unknown = result.lines[0];
      assert.equal(field(line, "state"), "completed");
      assert.deepEqual(field(line, "budget"), { limit: 6, spent });
      assert.equal(field(line, "sends"), spent);
      assert.deepEqual(field(line, "gates"), []);
      const segments: unknown = field(line, "segments");
      assert.ok(Array.isArray(segments));
      assert.equal(field(field(segments[0], "output"), "reason"), reason);
    }));

await test("CLV-122 generated configured action approval opens an approval gate", () =>
  withConsumer(
    generatedArtifact("configured-action-approval").source,
    async (consumer) => {
      const result =
        await consumer.run(`${generatedPrelude("configured-action-approval")}
const service = await openGenerated();
const runId = await submitGenerated();
await terminal(runId);
print(await generatedState(runId));
await service.close();
`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(field(result.lines[0], "gates"), [
        ["approval", "clv-gate-1"],
      ]);
    },
  ));

await test("CLV-122 unchanged generated source has only declared direct effects and is admitted by the real SDK compiler", async () => {
  const artifact = generatedArtifact();
  const facts = analyzeWorkflowCandidate(artifact.source);
  assert.deepEqual(facts.analysis.effects, [
    { capability: "claude", method: "run-turn" },
    { capability: "claude", method: "run-turn" },
  ]);
  assert.deepEqual(
    checkWorkflowCandidate({ declaration: artifact.declaration, ...facts }),
    [],
  );
  assert.equal((await admitWorkflowCandidate(artifact)).kind, "admitted");
});

await test("CLV-122 generated SDK review repairs routinely then opens exactly the associated design question", () =>
  withConsumer(generatedArtifact().source, async (consumer) => {
    const result = await consumer.run(`${generatedPrelude()}
const service = await openGenerated();
const runId = await submitGenerated();
await terminal(runId);
print(await generatedState(runId));
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    const line: unknown = result.lines[0];
    assert.equal(field(line, "state"), "waiting_gate");
    assert.deepEqual(field(line, "budget"), { limit: 6, spent: 3 });
    assert.equal(field(line, "effects"), 3);
    assert.equal(field(line, "sends"), 3);
    assert.deepEqual(field(line, "gates"), [["question", "clv-gate-1"]]);
  }));
