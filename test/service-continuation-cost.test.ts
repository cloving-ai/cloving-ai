import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

const step = (scope, capability, payload) =>
  protectedEffect({ scope, capability, method: "run-turn", target: "workspace/main", payload, units: 1 });

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await step({ phase: "implement", operation: "claude-turn", round: 1 }, "claude", "turn " + input.cycleId);
  const merge = await step({ phase: "merge", operation: "merge", round: 1 }, "fake-harness", "merge " + input.cycleId);
  if (merge.kind !== "completed") throw new Error(merge.reason ?? merge.kind);
  await step({ phase: "implement", operation: "claude-turn", round: 2 }, "claude", "check " + input.cycleId);
  return { kind: "handoff_requested", cycleId: input.cycleId };
}
`;

await test("CLV-321 a continuation counts only the cost of its own turns and shows the cost of the continued turns apart", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
const priced = {
  ...destination,
  deliver: async (intent) => {
    const [, round, , , operation] = JSON.parse(intent.operationId);
    if (existsSync("fail-merge") && operation === "merge") return { kind: "failed", reason: "git-call-failed", receipt: null, worker: null };
    const outcome = await destination.deliver(intent);
    if (operation !== "claude-turn") return outcome;
    return { ...outcome, result: JSON.stringify({ costUsd: round === 1 ? 19.17 : 2 }) };
  },
};
const registration = fakeRegistration([]);
const service = await hosted({ destination: priced, registrations: [{ ...registration, effectLimit: 5, manifest: { ...registration.manifest, capabilities: ["claude", "fake-harness"] } }] });
writeFileSync("fail-merge", "");
const runId = await submitted("c-1");
const finalState = async (id) => { await until(async () => ["completed", "failed"].includes(await stateOf(id))); return await stateOf(id); };
const before = await finalState(runId);
rmSync("fail-merge");
const reply = await asked("continue-run", { runId, commandId: "c-continue" });
const after = await finalState(reply.runId);
const costOf = async (id) => { const { run } = await asked("status", { runId: id }); return { claudeCostUsd: run.claudeCostUsd, continuedCostUsd: run.continuedCostUsd ?? null, reused: run.workerTurns.map((turn) => turn.reused === true) }; };
print({ before, after, old: await costOf(runId), continuation: await costOf(reply.runId) });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      before: "failed",
      after: "completed",
      old: { claudeCostUsd: 19.17, continuedCostUsd: null, reused: [false] },
      continuation: {
        claudeCostUsd: 2,
        continuedCostUsd: 19.17,
        reused: [true, false],
      },
    });
  }));
