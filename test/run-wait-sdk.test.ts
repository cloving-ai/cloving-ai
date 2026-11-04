import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import {
  runWaitPrelude as prelude,
  runWaitWorkflow as workflow,
} from "./run-wait-sdk-fixture.ts";

const everySecond =
  "{ runWaitChecks: { firstMilliseconds: 1000, maximumMilliseconds: 1000 } }";

await test("CLV-285 compiled wait survives a host crash, resumes its checks and continues with the child's outcome", () =>
  withConsumer(workflow, async (consumer) => {
    const first = await consumer.runUntil(
      "waiting-for-child",
      `${prelude}
writeFileSync("hold-retry", "");
await launched(${everySecond});
const root = await source();
const waiting = await until(async () => { const run = await shown(root.runId); return run.condition === "waiting-run" ? run : undefined; });
await until(async () => (await checkSteps(root.runId)).filter((step) => step.status === "completed").length >= 2 && (await sleeping(root.runId)));
await halt("waiting-for-child", { runId: root.runId, awaitedRunId: waiting.awaitedRunId, checks: (await checkSteps(root.runId)).length });
`,
    );
    const boundary = first.lines[0];
    assert.ok(typeof boundary === "object" && boundary !== null, first.stderr);
    assert.ok(
      "boundary" in boundary &&
        "runId" in boundary &&
        "awaitedRunId" in boundary,
      first.stderr,
    );
    assert.equal(boundary.boundary, "waiting-for-child", first.stderr);
    assert.ok(
      "checks" in boundary &&
        typeof boundary.runId === "string" &&
        typeof boundary.awaitedRunId === "string" &&
        typeof boundary.checks === "number",
      first.stderr,
    );
    const restarted = await consumer.run(`${prelude}
const daemon = await launched(${everySecond});
try {
  const root = await source();
  await until(async () => (await checkSteps(root.runId)).filter((step) => step.status === "completed").length > ${String(boundary.checks)});
  const resumed = await shown(root.runId);
  assert.equal(resumed.condition, "waiting-run");
  assert.equal(resumed.awaitedRunId, ${JSON.stringify(boundary.awaitedRunId)});
  rmSync("hold-retry");
  const completed = await ended(root.runId);
  assert.equal(completed.outcome?.kind, "handoff_requested", JSON.stringify(completed));
  assert.equal(completed.awaitedRunId, null);
  assert.deepEqual(readFileSync("outcomes", "utf8").trim().split("\\n").map(JSON.parse), [{ kind: "handoff_requested", reason: "small ticket", promotionId: "size-small" }]);
  const targets = (await runs()).filter((run) => run.workflowId === "size-ticket");
  assert.equal(targets.length, 1);
  const next = (await runs()).filter((run) => run.workflowId === "take-ticket");
  assert.equal(next.length, 1);
  assert.equal((await ended(next[0].runId)).outcome.promotionId, "size-small");
  print({ runId: root.runId, awaitedRunId: targets[0].runId });
} finally { await daemon.close(); }
`);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(restarted.lines, [
      {
        runId: boundary.runId,
        awaitedRunId: boundary.awaitedRunId,
      },
    ]);
  }));

await test("CLV-180 a replay before the wait checkpoint returns the same outcome", () =>
  withConsumer(workflow, async (consumer) => {
    const first = await consumer.runUntil(
      "before-wait-checkpoint",
      `${prelude}
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType !== "step_completed") return await create(...given);
  const step = await world.steps.get(given[0], given[1].correlationId, { resolveData: "none" });
  if (step.stepName.endsWith("//checkRunWait")) return await halt("before-wait-checkpoint");
  return await create(...given);
};
await launched();
await source();
await new Promise(() => undefined);
`,
    );
    const boundary = first.lines[0];
    assert.ok(typeof boundary === "object" && boundary !== null, first.stderr);
    assert.ok("boundary" in boundary, first.stderr);
    assert.equal(boundary.boundary, "before-wait-checkpoint", first.stderr);
    const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const root = await source();
  const completed = await ended(root.runId);
  assert.equal(completed.outcome.kind, "handoff_requested", JSON.stringify(completed));
  assert.deepEqual(readFileSync("outcomes", "utf8").trim().split("\\n").map(JSON.parse), [{ kind: "handoff_requested", reason: "small ticket", promotionId: "size-small" }]);
  assert.equal((await runs()).length, 3);
  assert.deepEqual(completed.budget, { limit: 2, spent: 2 });
} finally { await daemon.close(); }
`);
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(result.lines),
    );
  }));

await test("CLV-180 fan-out starts three runs without when-idle admission and waits for each", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
settings.workflows.queue = workflows.fanout;
settings.manifests.queue = settings.manifests.fanout;
settings.declarations[0].functionName = "fanout";
settings.declarations[0].effectLimit = 3;
const daemon = await launched();
try {
  const root = await source();
  const completed = await ended(root.runId);
  assert.equal(completed.outcome.kind, "handoff_requested", JSON.stringify(completed));
  const targets = (await runs()).filter((run) => run.workflowId === "size-ticket");
  assert.equal(targets.length, 3);
  const outcomes = JSON.parse(readFileSync("outcomes", "utf8"));
  assert.deepEqual(outcomes.map((outcome) => outcome.runId).sort(), targets.map((run) => run.runId).sort());
  for (const outcome of outcomes) assert.deepEqual(outcome, { runId: outcome.runId, kind: "handoff_requested", reason: "small ticket", promotionId: "size-small" });
  assert.deepEqual(completed.budget, { limit: 3, spent: 3 });
  const events = (await asked("events", { after: 0, limit: 1000, runId: root.runId })).events;
  assert.equal(events.filter((event) => event.type === "effect.requested" && event.payload.capability === "handoff").length, 3);
  for (const target of targets) assert.equal((await shown(target.runId)).parentRunId, root.runId);
} finally { await daemon.close(); }
`);
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(result.lines),
    );
  }));

await test("CLV-180 compiled wait refuses an operator's run and an unknown run", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const foreign = await submitted("foreign", { workflowId: "size-ticket", source: "input", submission: {} });
  for (const target of [foreign.runId, "missing-run"]) {
    const root = await submitted("wait-" + target, { workflowId: "queue", source: "input", submission: { target } });
    const completed = await ended(root.runId);
    assert.equal(completed.outcome.kind, "blocked");
    assert.equal(completed.outcome.reason, "run-wait-refused");
  }
  assert.equal((await runs()).filter((run) => run.workflowId === "take-ticket").length, 0);
} finally { await daemon.close(); }
`);
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(result.lines),
    );
  }));

await test("CLV-180 compiled wait times out", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
writeFileSync("hold-target", "");
const daemon = await launched();
try {
  for (const seconds of [1]) {
    const root = await submitted("wait-" + seconds, { workflowId: "queue", source: "input", submission: { seconds } });
    const completed = await ended(root.runId);
    assert.equal(completed.outcome.kind, "blocked");
    assert.equal(completed.outcome.reason, seconds === 1 ? "run-wait-timeout" : "run-wait-refused");
    assert.equal(completed.awaitedRunId, null);
  }
  assert.equal((await runs()).filter((run) => run.workflowId === "take-ticket").length, 0);
} finally { rmSync("hold-target"); await daemon.close(); }
`);
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(result.lines),
    );
  }));

for (const seconds of [0, 86401])
  await test(`CLV-180 compiled wait refuses the bound ${String(seconds)}`, () =>
    withConsumer(workflow, async (consumer) => {
      const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const root = await submitted("invalid-wait", { workflowId: "queue", source: "input", submission: { seconds: ${String(seconds)} } });
  const completed = await ended(root.runId);
  assert.equal(completed.outcome.kind, "blocked");
  assert.equal(completed.outcome.reason, "run-wait-refused");
} finally { await daemon.close(); }
`);
      assert.equal(
        result.status,
        0,
        result.stderr + JSON.stringify(result.lines),
      );
    }));
