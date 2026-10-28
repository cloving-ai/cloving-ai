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
  const otherPull = await reviewByAgent({ subject: { ...subject, number: 43 }, reviewer: { kind: "greptile" } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: first.subjectDigest, first, repeated, changed, otherPull };
}`;

await test("CLV-220 compiled Greptile reviews reuse only an unchanged subject and spend protected units", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`import assert from "node:assert/strict";
${servicePrelude}
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["github"] };
registration.effectLimit = 3;
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
  assert.equal(output.otherPull.accepted, false);
  assert.notEqual(output.otherPull.subjectDigest, output.first.subjectDigest);
  assert.deepEqual(delivered, [{ number: 42, commit: "${"a".repeat(40)}" }, { number: 42, commit: "${"b".repeat(40)}" }, { number: 43, commit: "${"a".repeat(40)}" }]);
  assert.deepEqual(run.budget, { limit: 3, spent: 3 });
  assert.equal(run.effects.length, 3);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

const turnWorkflow = `import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";
export async function candidate(input: { cycleId: string }) {
  "use workflow";
  const subject = { draft: "First draft" };
  const first = await reviewByAgent({ subject, reviewer: { kind: "turn", profile: "checker" } });
  const repeated = await reviewByAgent({ subject, reviewer: { kind: "turn", profile: "checker" } });
  const otherProfile = await reviewByAgent({ subject, reviewer: { kind: "turn", profile: "second" } });
  const changed = await reviewByAgent({ subject: { draft: "Changed draft" }, reviewer: { kind: "turn", profile: "checker" } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: first.subjectDigest, first, repeated, otherProfile, changed };
}`;

await test("CLV-220 compiled turn reviews reuse only the same immutable subject and named reviewer", () =>
  withConsumer(turnWorkflow, async (consumer) => {
    const result = await consumer.run(`import assert from "node:assert/strict";
${servicePrelude}
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["claude"] };
registration.effectLimit = 3;
const delivered = [];
const reviewer = {
  ...destination,
  deliver: async (intent) => {
    assert.equal(intent.capability, "claude");
    const prompt = await ports.document(intent.payload);
    delivered.push({ method: intent.method, target: intent.target, prompt });
    return { kind: "completed", receipt: "review-" + delivered.length,
      result: JSON.stringify({ reviewVerdict: delivered.length === 1 ? "accept" : "change", summary: "Feedback." }) };
  },
};
const service = await hosted({ registrations: [registration], workflow: workflows.candidate, destination: reviewer });
try {
  const runId = await submitted("turn-review");
  await until(async () => (await stateOf(runId)) === "completed");
  const run = (await asked("status", { runId })).run;
  const output = await getRun((await tagged())[0].receipt).returnValue;
  assert.equal(output.first.accepted, true);
  assert.deepEqual(output.repeated, output.first);
  assert.equal(output.first.commit, null);
  assert.equal(output.otherProfile.accepted, false);
  assert.equal(output.otherProfile.subjectDigest, output.first.subjectDigest);
  assert.equal(output.changed.accepted, false);
  assert.notEqual(output.changed.subjectDigest, output.first.subjectDigest);
  assert.deepEqual(delivered.map((entry) => entry.method), ["run-turn:checker", "run-turn:second", "run-turn:checker"]);
  assert.equal(delivered[0].target, output.first.subjectDigest);
  assert.equal(delivered[2].target, output.changed.subjectDigest);
  assert.match(delivered[0].prompt, /First draft/);
  assert.match(delivered[2].prompt, /Changed draft/);
  assert.deepEqual(run.budget, { limit: 3, spent: 3 });
  assert.equal(run.effects.length, 3);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
