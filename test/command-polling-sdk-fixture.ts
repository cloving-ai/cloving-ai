import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pollingWorkflow } from "./command-polling-fixture.ts";
import { productRoot, servicePrelude } from "./world-host-fixture.ts";

export const compiledPollingWorkflow = pollingWorkflow;

export const cancellationPollingWorkflow = `${pollingWorkflow}
export async function queueBarrier() {
  "use workflow";
  return "queue-observed";
}
`;

export const capacityPollingWorkflow = `${pollingWorkflow}
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function unrelated(input: { cycleId: string; input: { capability: string; method: string; target: string } }) {
  "use workflow";
  const result = await protectedEffect({ scope: { phase: "unrelated", operation: "effect", round: 1 }, capability: input.input.capability, method: input.input.method, target: input.input.target, payload: "{}", units: 1 });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: result.kind };
}
`;

const commandSource = `
const fs = require("node:fs");
const runId = process.env.CLOVING_RUN_ID;
const operationId = process.env.CLOVING_OPERATION_ID;
const calls = fs.existsSync("command-calls") ? fs.readFileSync("command-calls", "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
const round = calls.filter(call => call.runId === runId).length;
fs.appendFileSync("command-calls", JSON.stringify({ runId, operationId, pid: process.pid }) + "\\n");
const responses = JSON.parse(fs.readFileSync("responses", "utf8"));
process.stdout.write(JSON.stringify({ ready: responses[round] ?? false }));
`;

export const pollingPrelude = `${servicePrelude}
import assert from "node:assert/strict";
import { mock } from "node:test";
import { commandWorker } from ${JSON.stringify(pathToFileURL(join(productRoot, "src/daemon/command-worker.ts")).href)};
const saved = () => JSON.parse(readFileSync("sleep-checkpoint", "utf8"));
const commandCheckpoint = () => JSON.parse(readFileSync("command-checkpoint", "utf8"));
const initialTime = existsSync("sleep-checkpoint") ? saved().now : existsSync("command-checkpoint") ? commandCheckpoint().now : Date.now();
mock.timers.enable({ apis: ["Date"], now: initialTime + Number(process.env.CLOCK_OFFSET ?? 0) });
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["command"], commands: ["approval-status"] };
registration.effectLimit = Number(process.env.EFFECT_LIMIT ?? 30);
registration.resolver.resolve = async () => ({ kind: "resolved", input: { cycleId: "approval-cycle", input: { request: "merge-request-1" } } });
const commands = commandWorker({
  repository: process.cwd(), journal: process.cwd() + "/commands", seconds: 10,
  commands: { "approval-status": [process.execPath, "-e", ${JSON.stringify(commandSource)}] },
  document: digest => ports.document(digest), report: report => ports.reportEffect(report),
});
const pollingHost = (overrides = {}) => hosted({ registrations: [registration], workflow: workflows.approval, destination: commands, ...overrides });
const shown = async runId => (await asked("status", { runId })).run;
const sdkId = async runId => {
  const runs = (await tagged()).filter(run => run.run === runId);
  assert.equal(runs.length, 1);
  return runs[0].receipt;
};
const eventsOf = async runId => (await (await getWorld()).events.list({ runId: await sdkId(runId), pagination: { limit: 1000 } })).data;
const checks = runId => lines("command-calls").map(JSON.parse).filter(call => call.runId === runId);
const verifiedChecks = async (runId, count) => {
  const run = await shown(runId);
  assert.deepEqual(run.budget, { limit: registration.effectLimit, spent: count });
  assert.equal(run.effects.length, count);
  assert.ok(run.effects.every(effect => effect.state === "completed"));
  const calls = checks(runId);
  assert.equal(calls.length, count);
  assert.equal(new Set(calls.map(call => call.operationId)).size, count);
  assert.deepEqual(calls.map(call => JSON.parse(call.operationId)[1]), Array.from({ length: count }, (_, index) => index + 1));
  for (const call of calls) assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
};
const waitBarrier = async (expectedChecks = 1) => {
  const world = await getWorld();
  const create = world.events.create.bind(world.events);
  world.events.create = async (...given) => {
    const created = await create(...given);
    if (given[1]?.eventType !== "wait_created") return created;
    const runId = (await taggedRun(given[0])).runId;
    await verifiedChecks(runId, expectedChecks);
    if (existsSync("command-checkpoint")) {
      assert.equal(runId, commandCheckpoint().runId);
      assert.equal(given[0], commandCheckpoint().sdkId);
    }
    const checkpoint = { runId, sdkId: given[0], wait: created.event, now: initialTime };
    writeFileSync("sleep-checkpoint", JSON.stringify(checkpoint));
    await halt("sleep-persisted", checkpoint);
    return created;
  };
};
const sameWait = async () => {
  const checkpoint = saved();
  assert.equal(await sdkId(checkpoint.runId), checkpoint.sdkId);
  const waits = (await eventsOf(checkpoint.runId)).filter(event => event.eventType === "wait_created");
  assert.equal(waits.length, 1);
  assert.equal(waits[0].eventId, checkpoint.wait.eventId);
  assert.equal(waits[0].correlationId, checkpoint.wait.correlationId);
  assert.equal(waits[0].eventData.resumeAt.toISOString(), checkpoint.wait.eventData.resumeAt);
  return checkpoint;
};
const completedPolling = async runId => {
  await until(async () => (await stateOf(runId)) === "completed");
  const output = await getRun(await sdkId(runId)).returnValue;
  assert.equal(output.kind, "handoff_requested");
  assert.equal(output.promotionId, "external-condition-ready");
  assert.equal((await eventTypes(runId)).filter(type => type === "run.completed").length, 1);
  assert.equal((await ports.state()).intents.some(intent => intent.kind === "continue-run"), false);
};
`;
