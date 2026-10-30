import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { productRoot, servicePrelude } from "./world-host-fixture.ts";

export const commandWaitWorkflow = `import { waitForCommand } from "cloving/workflows/steps/wait-for-command";
export async function approval(input) {
  "use workflow";
  const outcome = await waitForCommand({ name: "team-review", input: { change: 42 } });
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: JSON.stringify(outcome) };
}`;

const source = `const fs = require("node:fs");
const calls = fs.existsSync("command-calls") ? fs.readFileSync("command-calls", "utf8").trim().split("\\n").filter(Boolean) : [];
fs.appendFileSync("command-calls", JSON.stringify({ operationId: process.env.CLOVING_OPERATION_ID, pid: process.pid }) + "\\n");
const responses = JSON.parse(fs.readFileSync("responses", "utf8"));
const result = responses[calls.length];
process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));`;

export const commandWaitPrelude = `${servicePrelude}
import assert from "node:assert/strict";
import { mock } from "node:test";
import { commandWorker } from ${JSON.stringify(pathToFileURL(join(productRoot, "src/daemon/command-worker.ts")).href)};
const saved = () => JSON.parse(readFileSync("wait-checkpoint", "utf8"));
const initialTime = existsSync("wait-checkpoint") ? saved().now : Date.now();
mock.timers.enable({ apis: ["Date"], now: initialTime + Number(process.env.CLOCK_OFFSET ?? 0) });
const registration = fakeRegistration([]);
registration.manifest = { ...registration.manifest, capabilities: ["command"], commands: ["review-state"], commandWaits: { "team-review": { command: "review-state", maximumWaitSeconds: 2592000, pollEverySeconds: 3600 } } };
registration.effectLimit = 1;
const commands = commandWorker({
  repository: process.cwd(), journal: process.cwd() + "/commands", seconds: 10,
  commands: { "review-state": [process.execPath, "-e", ${JSON.stringify(source)}] },
  document: digest => ports.document(digest), report: report => ports.reportEffect(report),
});
const waitHost = () => hosted({ registrations: [registration], workflow: workflows.approval, destination: commands });
const currentWait = async runId => ports.commandWait.read({ runId, name: "team-review" });
const worldId = async runId => (await tagged()).find(run => run.run === runId).receipt;
const eventsOf = async runId => (await (await getWorld()).events.list({ runId: await worldId(runId), pagination: { limit: 1000 } })).data;
const verified = async (runId, count) => {
  const wait = await currentWait(runId);
  assert.equal(wait.checkCount, count);
  assert.equal(wait.deadline, initialTime + registration.manifest.commandWaits["team-review"].maximumWaitSeconds * 1000);
  assert.deepEqual((await asked("status", { runId })).run.budget, { limit: 1, spent: 0 });
  const calls = lines("command-calls").map(JSON.parse);
  assert.equal(calls.length, count);
  assert.equal(new Set(calls.map(call => call.operationId)).size, count);
  for (const call of calls) assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
};
const waitBarrier = async (count = 1) => {
  const world = await getWorld();
  const create = world.events.create.bind(world.events);
  world.events.create = async (...given) => {
    const created = await create(...given);
    if (given[1]?.eventType !== "wait_created") return created;
    const runId = (await taggedRun(given[0])).runId;
    await verified(runId, count);
    const wait = await currentWait(runId);
    assert.equal(created.event.eventData.resumeAt.getTime(), Math.min(wait.nextCheckAt, wait.deadline));
    const checkpoint = { runId, sdkId: given[0], deadline: wait.deadline, now: initialTime };
    writeFileSync("wait-checkpoint", JSON.stringify(checkpoint));
    await halt("command-wait-suspended", checkpoint);
    return created;
  };
};
const completed = async (expected, count) => {
  const runId = saved().runId;
  await until(async () => (await stateOf(runId)) === "completed");
  assert.equal(await worldId(runId), saved().sdkId);
  const output = await getRun(saved().sdkId).returnValue;
  assert.deepEqual(JSON.parse(output.promotionId), expected);
  assert.equal((await currentWait(runId)).deadline, saved().deadline);
  await verified(runId, count);
};
`;
