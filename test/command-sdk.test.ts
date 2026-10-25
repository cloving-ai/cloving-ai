import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflow = `
import { runCommand } from "cloving/workflows/steps/run-command";
export async function candidate(input) {
  "use workflow";
  const result = await runCommand({
    scope: { phase: "scan", operation: "reviews", round: 1 },
    name: "review-requests",
    input: { cursor: null, labels: ["ready"] },
  });
  if (result.kind !== "completed") return { kind: "blocked", reason: result.reason ?? result.kind };
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: result.result };
}
`;

for (const [commands, sent, outcome] of [
  [["review-requests"], 1, "handoff_requested"],
  [["other"], 0, "blocked"],
] as const) {
  await test(`CLV-178 compiled command helper uses pinned names ${JSON.stringify(commands)} with a fake destination`, () =>
    withConsumer(workflow, async (consumer) => {
      const result =
        await consumer.run(`import assert from "node:assert/strict";
${servicePrelude}
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["command"], commands: ${JSON.stringify(commands)} };
registration.effectLimit = 1;
const delivered = [];
const command = {
  ...destination,
  deliver: async (intent) => {
    delivered.push(intent);
    assert.equal(intent.capability, "command");
    assert.equal(intent.method, "run:review-requests");
    assert.equal(intent.target, "review-requests");
    assert.equal(await ports.document(intent.payload), '{"cursor":null,"labels":["ready"]}');
    return { kind: "completed", receipt: "command-1", result: "raw stdout\\n" };
  },
};
const service = await hosted({ registrations: [registration], workflow: workflows.candidate, destination: command });
try {
  const runId = await submitted("command-1");
  await until(async () => (await stateOf(runId)) === "completed");
  const run = (await asked("status", { runId })).run;
  const world = (await tagged())[0];
  const output = await getRun(world.receipt).returnValue;
  assert.equal(output.kind, ${JSON.stringify(outcome)});
  assert.equal(delivered.length, ${String(sent)});
  assert.deepEqual(run.budget, { limit: 1, spent: ${String(sent)} });
  if (${String(sent)} === 1) {
    assert.equal(output.promotionId, "raw stdout\\n");
    assert.equal(run.effects.length, 1);
  } else {
    assert.equal(output.reason, "command-not-declared");
  }
} finally { await service.close(); }
`);
      assert.equal(result.status, 0, result.stderr);
    }));
}
