import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { field } from "./claude-worker-fixture.ts";
import {
  generatedArtifact,
  generatedPrelude,
} from "./chats-workflow-generation-sdk-fixture.ts";

function assertFollowup(payloads: unknown, count: number): void {
  assert.ok(Array.isArray(payloads));
  const followup = payloads.filter(
    (payload: unknown) => field(payload, "decision") !== undefined,
  );
  assert.equal(followup.length, count);
  for (const payload of followup) {
    assert.deepEqual(field(payload, "decision"), {
      gateId: "clv-gate-1",
      decision: "answered",
      answer: "Use the other synthetic design.",
    });
    assert.equal(field(payload, "round"), 2);
    assert.match(
      String(field(field(payload, "asset"), "instructions")),
      /apply.*design answer.*check/i,
    );
  }
}

for (const [mode, count, spent] of [
  ["complete", 1, 4],
  ["repair", 2, 5],
  ["exhaust", 0, 5],
] as const)
  await test(`CLV-122 design continuation applies the answer within remaining iterations: ${mode}`, () =>
    withConsumer(generatedArtifact().source, async (consumer) => {
      const result = await consumer.run(`${generatedPrelude()}
const payloads = [];
const worker = { ...destination, deliver: async (intent) => {
  const payload = JSON.parse(await ports.document(intent.payload));
  payloads.push(payload);
  const outcome = await destination.deliver(intent);
  const status = payload.decision === undefined || (${JSON.stringify(mode)} === "repair" && payload.round === 2) ? "repair" : "complete";
  const initial = payload.decision === undefined && payload.round === ${mode === "exhaust" ? "2" : "1"} && payload.asset.name === "clvAsset1";
  return { ...outcome, result: JSON.stringify({ summary: JSON.stringify({ status: initial ? "complete" : status }) }) };
} };
const service = await openGenerated({ destination: worker });
const runId = await submitGenerated();
await terminal(runId);
const [gate] = (await asked("questions", { runId })).decisions;
const answer = "Use the other synthetic design.";
await asked("decision", { command: "answer", reference: gate.decisionId, text: answer, subjectDigest: gate.subjectDigest, expectedRevision: gate.revision, generation: gate.generation, commandId: "design-answer" });
await until(async () => (await tagged()).length === 2);
await terminal(runId);
print({ payloads, state: await generatedState(runId) });
await service.close();
`);
      assert.equal(result.status, 0, result.stderr);
      const line: unknown = result.lines[0];
      assertFollowup(field(line, "payloads"), count);
      const state = field(line, "state");
      assert.deepEqual(field(state, "budget"), {
        limit: 6,
        spent,
      });
      const segments: unknown = field(state, "segments");
      assert.ok(Array.isArray(segments));
      assert.equal(
        field(field(segments[1], "output"), "kind"),
        mode === "complete" ? "handoff_requested" : "blocked",
      );
      assert.equal(
        field(field(segments[1], "output"), "reason"),
        mode === "complete" ? undefined : "repair-limit-exhausted",
      );
    }));
