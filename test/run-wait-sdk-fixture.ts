import { queuePrelude } from "./daemon-queue-fixture.ts";

export const runWaitWorkflow = `
import { appendFileSync, existsSync } from "node:fs";
import { RetryableError, sleep } from "workflow";
import { handoff } from "cloving/workflows/steps/handoff";
import { waitForRun } from "cloving/workflows/steps/wait-for-run";
export async function held() {
  "use step";
  return existsSync("hold-target");
}
export async function finish(input) {
  "use step";
  if (existsSync("hold-retry")) throw new RetryableError("held", { retryAfter: 1000 });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "size-small", reason: "small ticket" };
}
finish.maxRetries = 100;
export async function received(outcome) {
  "use step";
  appendFileSync("outcomes", JSON.stringify(outcome) + "\\n");
}
export async function queue(input) {
  "use workflow";
  const target = input.input.target ?? await handoff({ workflowId: "size-ticket", input: {} });
  let outcome;
  try {
    outcome = await waitForRun({ runId: target, maximumWaitSeconds: input.input.seconds ?? 60 });
  } catch (error) {
    return { kind: "blocked", cycleId: input.cycleId, evidenceId: "fixture", reason: error.message };
  }
  await received(outcome);
  const next = await handoff({ workflowId: "take-ticket", input: { verdict: outcome.promotionId } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: next };
}
export async function size(input) {
  "use workflow";
  while (await held()) await sleep(1000);
  return await finish(input);
}
export async function take(input) {
  "use workflow";
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: input.input.verdict };
}
export async function earlierWaitForRun(request) {
  "use step";
  const bridge = Reflect.get(globalThis, Symbol.for("cloving.step-bridge/v1"));
  if (!["effect", "gate"].every((member) => typeof Reflect.get(Object(bridge), member) === "function") || bridge.waitForRun === undefined)
    throw new Error("cloving-host-unavailable");
  return await bridge.waitForRun(request);
}
earlierWaitForRun.maxRetries = 86401;
export async function earlier(input) {
  "use workflow";
  const target = await handoff({ workflowId: "size-ticket", input: {} });
  const outcome = await earlierWaitForRun({ runId: target, maximumWaitSeconds: 600 });
  await received(outcome);
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: outcome.promotionId };
}
export async function fanout(input) {
  "use workflow";
  const targets = [];
  for (let index = 0; index < 3; index += 1) targets.push(await handoff({ workflowId: "size-ticket", input: {} }));
  const outcomes = [];
  for (const runId of targets) outcomes.push({ runId, ...await waitForRun({ runId, maximumWaitSeconds: 60 }) });
  await received(outcomes);
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "all-small" };
}
`;

export const runWaitPrelude = `${queuePrelude}
settings.queueMilliseconds = undefined;
for (const name of ["queue", "size", "take", "fanout", "earlier"]) {
  const definition = Object.values(compiled.workflows).flatMap(Object.values).find((entry) => entry.workflowId.endsWith("//" + name));
  writeFileSync(name + ".workflow.json", JSON.stringify({ schemaVersion: 1, name, workflowId: definition.workflowId, steps: [], capabilities: [], resources: [], artifacts: "artifacts" }));
  settings.manifests[name] = directory + "/" + name + ".workflow.json";
  settings.workflows[name] = workflows[name];
}
settings.declarations = [
  { workflowId: "queue", functionName: "queue", effectLimit: 2, capabilities: [], handoffs: ["size-ticket", "take-ticket"], input: { maximumBytes: 4096, fields: { target: { type: "string", optional: true }, seconds: { type: "integer", optional: true } } } },
  { workflowId: "size-ticket", functionName: "size", effectLimit: 0, capabilities: [], input: { maximumBytes: 4096, fields: {} } },
  { workflowId: "take-ticket", functionName: "take", effectLimit: 0, capabilities: [], input: { maximumBytes: 4096, fields: { verdict: { type: "string" } } } },
];
const source = () => submitted("queue-root", { workflowId: "queue", source: "input", submission: {} });
const ended = (runId) => until(async () => { const run = await shown(runId); return ["completed", "failed", "cancelled"].includes(run?.state) ? run : undefined; }).catch(async (error) => { print({ diagnostic: await shown(runId), sdk: await (await getWorld()).runs.list({ resolveData: "none" }), events: (await asked("events", { after: 0, limit: 1000, runId })).events }); throw error; });
const worldRun = async (runId) => (await (await getWorld()).runs.list({ resolveData: "none" })).data.find((run) => run.attributes["cloving.run"] === runId);
const sdkRun = async (runId) => { const run = await worldRun(runId); assert.ok(run, "world-run-missing " + runId); return run.runId; };
const checkSteps = async (runId) => { const run = await worldRun(runId); return run === undefined ? [] : (await (await getWorld()).steps.list({ runId: run.runId, resolveData: "none", pagination: { limit: 1000 } })).data.filter((step) => step.stepName.endsWith("//checkRunWait")); };
const sleeping = async (runId) => (await worldEvents(runId)).at(-1)?.eventType === "wait_created";
const worldEvents = async (runId) => (await (await getWorld()).events.list({ runId: await sdkRun(runId), pagination: { limit: 10000 } })).data;
`;
