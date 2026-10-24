import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";

const workflow = `
import { handoff } from "cloving/workflows/steps/handoff";
export async function chain(input) {
  "use workflow";
  try {
    if (input.input.remaining > 1) {
      const runId = await handoff({ workflowId: "chain", input: { remaining: input.input.remaining - 1 } });
      return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: runId };
    }
    return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "finished" };
  } catch (error) {
    return { kind: "blocked", reason: error.message };
  }
}
`;

const prelude = `${queuePrelude}
settings.queueMilliseconds = undefined;
writeFileSync("chain.workflow.json", JSON.stringify({ schemaVersion: 1, name: "chain", workflowId: definition.workflowId, steps: [], capabilities: [], resources: [], artifacts: "artifacts" }));
settings.manifests.chain = directory + "/chain.workflow.json";
settings.workflows.chain = workflows.chain;
settings.declarations = [{ workflowId: "chain", functionName: "chain", effectLimit: 1, capabilities: [], handoffs: ["chain"], input: { maximumBytes: 4096, fields: { remaining: { type: "integer", minimum: 1 } } } }];
`;

await test("CLV-183 compiled Local World permits five runs and refuses the sixth without starting it", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  await submitted("chain-root", { workflowId: "chain", source: "input", submission: { remaining: 6 } });
  await until(async () => {
    const listed = await runs();
    return listed.length >= 5 && listed.every((run) => run.state === "completed");
  });
  const listed = await runs();
  assert.equal(listed.length, 5, "The sixth handoff must start no run");
  const details = await Promise.all(listed.map((run) => shown(run.runId)));
  const last = details.find((run) => run.input.remaining === 2);
  assert.equal(last.outcome.kind, "blocked");
  assert.ok(last.outcome.reason.includes("chain-limit"), JSON.stringify(last));
  assert.equal(details.filter((run) => run.outcome.kind === "handoff_requested").length, 4);
} finally { await daemon.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-183 compiled handoff parent and chain IDs survive a service process restart", () =>
  withConsumer(workflow, async (consumer) => {
    const first = await consumer.run(`${prelude}
const daemon = await launched();
try {
  await submitted("restart-root", { workflowId: "chain", source: "input", submission: { remaining: 3 } });
  await until(async () => {
    const listed = await runs();
    return listed.length === 3 && listed.every((run) => run.state === "completed");
  });
} finally { await daemon.close(); }
`);
    assert.equal(first.status, 0, first.stderr);
    const restarted = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const details = await Promise.all((await runs()).map((run) => shown(run.runId)));
  const ordered = details.toSorted((a, b) => b.input.remaining - a.input.remaining);
  assert.equal(ordered.length, 3);
  for (const [index, run] of ordered.entries()) {
    assert.equal(run.parentRunId, index === 0 ? null : ordered[index - 1].runId);
    assert.equal(run.chainId, ordered[0].runId);
    assert.deepEqual(run.childRunIds, index === 2 ? [] : [ordered[index + 1].runId]);
  }
  const replay = await submitted("restart-root", { workflowId: "chain", source: "input", submission: { remaining: 3 } });
  assert.equal(replay.runId, ordered[0].runId);
  assert.equal((await runs()).length, 3);
} finally { await daemon.close(); }
`);
    assert.equal(restarted.status, 0, restarted.stderr);
  }));
