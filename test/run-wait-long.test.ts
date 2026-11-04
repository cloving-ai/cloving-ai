import assert from "node:assert/strict";
import { test } from "node:test";
import { runWaitPrelude, runWaitWorkflow } from "./run-wait-sdk-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-285 a parent waits through more than 48 checks of an active child with no step retries and gets its outcome", () =>
  withConsumer(runWaitWorkflow, async (consumer) => {
    const result = await consumer.runWithin(
      `${runWaitPrelude}
writeFileSync("hold-target", "");
const daemon = await launched({ runWaitChecks: { firstMilliseconds: 1, maximumMilliseconds: 1 } });
try {
  const root = await submitted("long-wait", { workflowId: "queue", source: "input", submission: { seconds: 3600 } });
  const limit = performance.now() + testMilliseconds(100000);
  let checked = [];
  while (checked.length <= 48 && performance.now() < limit) {
    const parent = await shown(root.runId);
    assert.equal(["completed", "failed", "cancelled"].includes(parent.state), false, JSON.stringify(parent));
    checked = await checkSteps(root.runId);
    await delay(200);
  }
  assert.ok(checked.length > 48, String(checked.length));
  const child = (await runs()).find((run) => run.workflowId === "size-ticket");
  const waiting = await shown(root.runId);
  assert.equal(waiting.condition, "waiting-run");
  assert.equal(waiting.awaitedRunId, child.runId);
  assert.equal((await shown(child.runId)).state, "running");
  rmSync("hold-target");
  const completed = await ended(root.runId);
  assert.equal(completed.outcome.kind, "handoff_requested", JSON.stringify(completed));
  assert.deepEqual(readFileSync("outcomes", "utf8").trim().split("\\n").map(JSON.parse), [{ kind: "handoff_requested", reason: "small ticket", promotionId: "size-small" }]);
  const steps = await checkSteps(root.runId);
  assert.deepEqual(steps.filter((step) => step.attempt !== 1 || step.status !== "completed"), []);
  const events = await worldEvents(root.runId);
  assert.equal(events.filter((event) => event.eventType === "step_retrying").length, 0);
  assert.equal(events.filter((event) => event.eventType === "wait_completed").length, steps.length - 1);
  print({ checks: steps.length > 48 });
} finally { await daemon.close(); }
`,
      testMilliseconds(150000),
    );
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(result.lines),
    );
    assert.deepEqual(result.lines, [{ checks: true }]);
  }));
