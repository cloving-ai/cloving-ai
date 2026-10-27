import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { withConsumer } from "./world-host-fixture.ts";
import { decisionPrelude, decisionWorkflow } from "./decision-wait-fixture.ts";

const resumeModule = new URL("../src/host/decision-resume.ts", import.meta.url)
  .href;

await test("CLV-219 decision delivery and recovery find hooks across all SDK event pages", async () => {
  const script = `
import assert from "node:assert/strict";
import { mock } from "node:test";
let received = true;
const resumes = [];
const reads = [];
const token = "cloving-decision/v1/run-1/review-1";
const created = { eventType: "hook_created", correlationId: "hook-1", eventData: { token } };
const accepted = { eventType: "hook_received", correlationId: "hook-1" };
mock.module("workflow/runtime", { namedExports: { getWorld: async () => ({ events: {
  list: async ({ runId, resolveData, pagination }) => {
    assert.equal(runId, "sdk-run");
    assert.equal(resolveData, "none");
    const cursor = pagination?.cursor;
    reads.push(cursor ?? null);
    if (cursor === undefined) return { data: [{ eventType: "run_created" }], hasMore: true, cursor: "created" };
    assert.equal(pagination.limit, 1000);
    assert.equal(pagination.sortOrder, "asc");
    if (cursor === "created") return { data: [created], hasMore: true, cursor: "received" };
    assert.equal(cursor, "received");
    return { data: received ? [accepted] : [], hasMore: false, cursor: null };
  },
} }) } });
mock.module("workflow/api", { namedExports: { resumeHook: async (given, result) => {
  resumes.push([given, result]);
  received = true;
} } });
const { reconciledDecision, deliveredDecision } = await import(${JSON.stringify(resumeModule)});
const operationId = JSON.stringify(["cloving-operation", 0, "run-1", "develop", "start-run", null, null]);
const parts = { runs: async () => [{ operationId, receipt: "sdk-run" }], document: async () => undefined };
const intent = { runId: "run-1", gateId: "review-1", decision: "approved", answer: null };
try {
  assert.deepEqual(await reconciledDecision(parts, intent), { kind: "accepted", receipt: "sdk-run" });
  assert.deepEqual(await deliveredDecision(parts, { intent, signal: undefined }), { receipt: "sdk-run" });
  assert.deepEqual(resumes, []);
  received = false;
  assert.deepEqual(await reconciledDecision(parts, intent), { kind: "absent" });
  assert.deepEqual(await deliveredDecision(parts, { intent, signal: AbortSignal.timeout(1000) }), { receipt: "sdk-run" });
  assert.deepEqual(resumes, [[token, { decision: "approved", answer: null }]]);
  assert.deepEqual(reads, Array.from({ length: 4 }, () => [null, "created", "received"]).flat());
} finally { mock.restoreAll(); }
`;
  const result = await promisify(execFile)(process.execPath, [
    "--experimental-test-module-mocks",
    "--input-type=module",
    "-e",
    script,
  ]);
  assert.equal(result.stdout, "");
});

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

await test("CLV-219 hook recovery requires an unambiguous original SDK run", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const { reconciledDecision, deliveredDecision } = await import(${JSON.stringify(resumeModule)});
const service = await hosted();
try {
  const runId = await submitted("recovery-identity");
  await pendingGate(runId);
  await hookReady(runId);
  const intent = { runId, gateId: "review-1", decision: "approved", answer: null };
  const parts = { runs: taggedRuns, document: async () => undefined };
  await assert.rejects(reconciledDecision(parts, { runId }), /missing-decision-gate/);
  await assert.rejects(reconciledDecision({ ...parts, runs: async () => [{ operationId: null, receipt: "foreign" }] }, intent), /missing-decision-run/);
  const runs = await taggedRuns();
  await assert.rejects(reconciledDecision({ ...parts, runs: async () => [...runs, ...runs] }, intent), /conflicting-decision-hooks/);
  assert.deepEqual(await reconciledDecision(parts, intent), { kind: "absent" });
  await decide(runId);
  const receipt = await verified(runId);
  assert.deepEqual(await reconciledDecision(parts, intent), { kind: "accepted", receipt });
  assert.deepEqual(await deliveredDecision(parts, { intent, signal: undefined }), { receipt });
  assert.deepEqual(decisions(), [{ decision: "approved", answer: null }]);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-219 incomplete or aborted hook deliveries preserve the pending decision", () =>
  withConsumer(decisionWorkflow, async (consumer) => {
    const result = await consumer.run(`${decisionPrelude}
const { deliveredDecision, stoppedDecision } = await import(${JSON.stringify(resumeModule)});
const service = await hosted();
try {
  const runId = await submitted("recovery-validation");
  await pendingGate(runId);
  await hookReady(runId);
  const intent = { runId, gateId: "review-1", decision: "approved" };
  const parts = { runs: taggedRuns, document: async () => undefined };
  await assert.rejects(deliveredDecision(parts, { intent: { runId, gateId: "review-1" }, signal: undefined }), /missing-decision/);
  await assert.rejects(deliveredDecision(parts, { intent: { ...intent, answer: "sha256:missing" }, signal: undefined }), /missing-decision-answer/);
  const world = await getWorld();
  const list = world.events.list.bind(world.events);
  world.events.list = async () => ({ data: [] });
  try {
    await assert.rejects(deliveredDecision(parts, { intent, signal: AbortSignal.abort() }), { name: "AbortError" });
  } finally { world.events.list = list; }
  const receipt = await sdkRun(runId);
  for (const status of ["running", "cancelled", "completed", "failed"]) {
    const cancel = async (given) => { assert.equal(given, receipt); return status; };
    assert.deepEqual(await stoppedDecision({ ...parts, cancel }, intent), status === "running" ? { kind: "unknown", evidence: "world-run:" + receipt + " running" } : { kind: "stopped", receipt });
  }
  assert.equal((await sdkEvents(runId)).filter((event) => event.eventType === "hook_received").length, 0);
  await decide(runId);
  await verified(runId);
} finally { await service.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));
