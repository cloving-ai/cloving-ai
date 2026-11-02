import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function develop() {
  "use workflow";
  await protectedEffect({ scope: { phase: "work", operation: "effect", round: 1 }, capability: "fake-harness", method: "run-turn", target: "workspace/main", payload: "before the wait", units: 1 });
  const decision = await waitForDecision({ gateId: "design-1", kind: "question", prompt: "question of run-1" });
  return { kind: "handoff_requested", promotionId: "original:" + decision.answer };
}

export async function editedDevelop() {
  "use workflow";
  return { kind: "handoff_requested", promotionId: "edited" };
}
`;

const versions = `
import { workflowPin } from ${JSON.stringify(new URL("../src/broker/workflow-pin.ts", import.meta.url).href)};
import { changedManifest } from ${JSON.stringify(new URL("./service-views.ts", import.meta.url).href)};
const original = { ...fakeRegistration([]), effectLimit: 5 };
const current = { ...original, manifest: changedManifest, effectLimit: 50 };
const originalPin = workflowPin(original.manifest);
const resolveWorkflow = async (intent) => intent.workflow === originalPin ? workflows.develop : workflows.editedDevelop;
const budget = async (runId) => (await asked("status", { runId })).run.budget;
`;

await test("CLV-153 supplied retained executables preserve continuation selection, duplicate answers and spending across restart", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.run(`${servicePrelude}${versions}
const service = await hosted();
const runId = await submitted("original");
await until(async () => (await stateOf(runId)) === "waiting_gate");
await until(async () => (await (await getWorld()).events.list({ runId: (await tagged())[0].receipt, resolveData: "none" })).data.some(event => event.eventType === "hook_created"));
print({ runId, budget: await budget(runId) });
await service.close();
`);
    assert.equal(first.status, 0, first.stderr);
    const runId: unknown = Reflect.get(Object(first.lines[0]), "runId");
    assert.ok(typeof runId === "string");
    assert.deepEqual(first.lines, [{ runId, budget: { limit: 5, spent: 1 } }]);
    const second = await consumer.run(
      `${servicePrelude}${versions}
const service = await hosted({ registrations: [current], retainedWorkflows: [original], resolveWorkflow });
const runId = process.env.RUN_ID;
const parameters = { subjectDigest: digestOf("question of run-1") };
const answer = await answered(runId, parameters);
const duplicate = await answered(runId, parameters);
await until(async () => (await stateOf(runId)) === "completed");
const edited = await submitted("edited");
await until(async () => (await stateOf(edited)) === "completed");
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const outputs = (await segments()).map((segment) => segment.output.promotionId ?? null);
print({ answers: [answer.kind, duplicate.kind], outputs, effects: lines("destination.log").length, budgets: [await budget(runId), await budget(edited)], workflows: (await asked("status", {})).workflows });
await service.close();
`,
      { RUN_ID: runId },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(second.lines, [
      {
        answers: ["decision-recorded", "decision-recorded"],
        outputs: ["original:Use the table parser.", "edited"],
        effects: 1,
        budgets: [
          { limit: 5, spent: 1 },
          { limit: 50, spent: 0 },
        ],
        workflows: ["develop"],
      },
    ]);
  }));
