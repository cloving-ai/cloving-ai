import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { decisionPrelude, decisionWorkflow } from "./decision-wait-fixture.ts";

const crashes = [
  {
    boundary: "waiting",
    script: `
const service = await hosted();
const runId = await submitted("crash");
await pendingGate(runId);
await hookReady(runId);
await halt("waiting", { receipt: await sdkRun(runId) });
`,
    decisionPending: true,
  },
  {
    boundary: "before-resume",
    script: `
const service = await hosted({ wrap: (product) => ({ ...product, deliver: async (intent, signal) => {
  if (intent.kind === "resume-hook") return await halt("before-resume", { receipt: await sdkRun(intent.runId) });
  return await product.deliver(intent, signal);
} }) });
const runId = await submitted("crash");
await pendingGate(runId);
await hookReady(runId);
await decide(runId);
await new Promise(() => undefined);
`,
    decisionPending: false,
  },
  {
    boundary: "after-resume",
    script: `
const service = await hosted({ wrap: (product) => ({ ...product, deliver: async (intent, signal) => {
  const result = await product.deliver(intent, signal);
  if (intent.kind === "resume-hook") {
    await until(async () => (await sdkEvents(intent.runId)).some((event) => event.eventType === "step_completed" && event.eventData.stepName?.endsWith("//recordDecision")));
    return await halt("after-resume", { receipt: await sdkRun(intent.runId) });
  }
  return result;
} }) });
const runId = await submitted("crash");
await pendingGate(runId);
await hookReady(runId);
await decide(runId);
await new Promise(() => undefined);
`,
    decisionPending: false,
  },
  {
    boundary: "before-completion",
    script: `
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType === "run_completed") return await halt("before-completion", { receipt: given[0] });
  return await create(...given);
};
const service = await hosted();
const runId = await submitted("crash");
await pendingGate(runId);
await hookReady(runId);
await decide(runId);
await new Promise(() => undefined);
`,
    decisionPending: false,
  },
];

for (const crash of crashes)
  await test(`CLV-219 a process crash at ${crash.boundary} resumes the original SDK call once`, () =>
    withConsumer(decisionWorkflow, async (consumer) => {
      const first = await consumer.runUntil(
        crash.boundary,
        decisionPrelude + crash.script,
      );
      const boundary = first.lines[0];
      assert.ok(typeof boundary === "object" && boundary !== null);
      assert.ok("boundary" in boundary && "receipt" in boundary);
      assert.equal(boundary.boundary, crash.boundary, first.stderr);
      const result = await consumer.run(`${decisionPrelude}
const service = await hosted();
try {
  const runId = (await tagged())[0].run;
  if (${String(crash.decisionPending)}) await decide(runId);
  const receipt = await verified(runId);
  assert.deepEqual(decisions(), [{ decision: "approved", answer: null }]);
  print({ receipt });
} finally { await service.close(); }
`);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines, [{ receipt: boundary.receipt }]);
    }));

await test("CLV-219 approval before the hook is ready reaches the same call", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
writeFileSync("hold-open", "");
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType === "step_completed") {
    const step = await world.steps.get(given[0], given[1].correlationId, { resolveData: "none" });
    if (step.stepName.endsWith("//openDecisionWait")) await holdAt("hold-open");
  }
  return await create(...given);
};
const service = await hosted();
try {
  const runId = await submitted("early");
  await until(() => existsSync("hold-open-entered"));
  assert.equal((await sdkEvents(runId)).some((event) => event.eventType === "hook_created"), false);
  assert.equal((await decide(runId)).kind, "decision-recorded");
  assert.equal((await ports.state()).intents.filter((intent) => intent.kind === "resume-hook").length, 1);
  rmSync("hold-open");
  await verified(runId);
  assert.deepEqual(decisions(), [{ decision: "approved", answer: null }]);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

const expirySetup = `${decisionPrelude}
let now = "2099-10-20T09:59:59.000Z";
writeFileSync("gate-settings", JSON.stringify({ expiresAt: "2099-10-20T10:00:00.000Z" }));
const service = await hosted({ clock: () => now });
const runId = await submitted("expiry");
await pendingGate(runId);
await hookReady(runId);
`;

const expired = `
try {
  now = "2099-10-20T10:00:00.000Z";
  await verified(runId, { decision: "expired", answer: null });
  assert.deepEqual(decisions(), [{ decision: "expired", answer: null }]);
} finally { await service.close(); }
`;

await test("CLV-219 expiry returns expired with a null answer", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(expirySetup + expired);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-219 expiry across a restart returns expired with a null answer", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "expiry-wait",
      expirySetup + 'await halt("expiry-wait");',
    );
    assert.deepEqual(first.lines, [{ boundary: "expiry-wait" }]);
    const resumed = `${decisionPrelude}
let now = "2099-10-20T09:59:59.000Z";
const service = await hosted({ clock: () => now });
const runId = (await tagged())[0].run;
`;
    const result = await consumer.run(resumed + expired);
    assert.equal(result.status, 0, result.stderr);
  }));
