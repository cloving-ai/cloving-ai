import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflow = `import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";
export async function candidate(input: { cycleId: string }) {
  "use workflow";
  const subject = { target: input.cycleId, commit: "${"a".repeat(40)}", number: 42 };
  const first = await reviewByAgent({ subject, reviewer: { kind: "greptile" } });
  const repeated = await reviewByAgent({ subject, reviewer: { kind: "greptile" } });
  const changed = await reviewByAgent({ subject: { ...subject, commit: "${"b".repeat(40)}" }, reviewer: { kind: "greptile" } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: first.subjectDigest, first, repeated, changed };
}`;

await test("CLV-220 compiled Greptile reviews reuse only an unchanged subject and spend protected units", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`import assert from "node:assert/strict";
${servicePrelude}
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["github"] };
registration.effectLimit = 2;
const delivered = [];
const github = {
  ...destination,
  deliver: async (intent) => {
    assert.equal(intent.capability, "github");
    assert.equal(intent.method, "wait-review");
    const pull = JSON.parse(await ports.document(intent.payload));
    delivered.push(pull);
    return { kind: "completed", receipt: "review-" + delivered.length,
      result: JSON.stringify({ ...pull, score: delivered.length === 1 ? 5 : 4, summary: "Feedback.", findings: [] }) };
  },
};
const service = await hosted({ registrations: [registration], workflow: workflows.candidate, destination: github });
try {
  const runId = await submitted("agent-review");
  await until(async () => (await stateOf(runId)) === "completed");
  const run = (await asked("status", { runId })).run;
  const output = await getRun((await tagged())[0].receipt).returnValue;
  assert.equal(output.first.accepted, true);
  assert.deepEqual(output.repeated, output.first);
  assert.equal(output.changed.accepted, false);
  assert.notEqual(output.changed.subjectDigest, output.first.subjectDigest);
  assert.deepEqual(delivered, [{ number: 42, commit: "${"a".repeat(40)}" }, { number: 42, commit: "${"b".repeat(40)}" }]);
  assert.deepEqual(run.budget, { limit: 2, spent: 2 });
  assert.equal(run.effects.length, 2);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
