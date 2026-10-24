import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";

const workflow = `
import { appendFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { handoff } from "cloving/workflows/steps/handoff";
export async function received(input) {
  "use step";
  while (existsSync("hold-target")) await delay(10);
  appendFileSync("targets.log", JSON.stringify(input.input) + "\\n");
}
export async function a(input) {
  "use workflow";
  try {
    const runId = await handoff({ workflowId: "B", input: input.input });
    if (input.input.prompt === "twice") {
      const nextRunId = await handoff({ workflowId: "B", input: input.input });
      return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: nextRunId };
    }
    return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: runId };
  } catch (error) {
    return { kind: "blocked", reason: error.message };
  }
}
export async function b(input) {
  "use workflow";
  await received(input);
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "target-finished" };
}
`;

const prelude = `${queuePrelude}
settings.queueMilliseconds = undefined;
for (const name of ["a", "b"]) {
  const definition = Object.values(compiled.workflows).flatMap(Object.values).find((entry) => entry.workflowId.endsWith("//" + name));
  writeFileSync(name + ".workflow.json", JSON.stringify({ schemaVersion: 1, name, workflowId: definition.workflowId, steps: [], capabilities: [], resources: [], artifacts: "artifacts" }));
  settings.manifests[name] = directory + "/" + name + ".workflow.json";
  settings.workflows[name] = workflows[name];
}
settings.declarations = [
  { workflowId: "A", functionName: "a", effectLimit: 1, capabilities: [], handoffs: ["B"], input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } } },
  { workflowId: "B", functionName: "b", effectLimit: 1, capabilities: [], input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } } },
];
const submitA = async () => submitted("source", { workflowId: "A", source: "input", submission: { prompt: "next" } });
const ended = async (runId) => until(async () => { const run = await shown(runId); return ["completed", "blocked", "failed"].includes(run?.state) ? run : undefined; });
const targetInputs = () => linesOfTargets();
const linesOfTargets = () => existsSync("targets.log") ? readFileSync("targets.log", "utf8").trim().split("\\n").map(JSON.parse) : [];
`;

const lostReply = `
const { default: net } = await import("node:net");
const connect = net.connect.bind(net);
net.connect = (...argumentsList) => {
  const socket = connect(...argumentsList);
  const emit = socket.emit.bind(socket);
  let buffered = "";
  let held = false;
  socket.emit = (event, ...given) => {
    if (held) return true;
    if (event === "data") {
      buffered += String(given[0]);
      if (buffered.includes("\\n")) {
        const reply = JSON.parse(buffered.split("\\n")[0]);
        if (reply.result?.commandId?.startsWith("handoff:")) {
          held = true;
          print({ boundary: "handoff-reply-lost", targetRunId: reply.result.runId, resultSaved: existsSync("handoffs") && readdirSync("handoffs", { recursive: true }).some((name) => name.endsWith("result.json")) });
          return true;
        }
      }
    }
    return emit(event, ...given);
  };
  return socket;
};
writeFileSync("hold-target", "");
await launched();
await submitA();
await new Promise(() => undefined);
`;

await test("CLV-182 compiled handoff starts B once with the input and returns B's run ID", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
const daemon = await launched();
try {
  const source = await submitA();
  const completed = await ended(source.runId);
  assert.equal(completed.outcome?.kind, "handoff_requested", JSON.stringify(completed));
  const targets = (await runs()).filter((run) => run.workflowId === "B");
  assert.equal(targets.length, 1);
  assert.equal(completed.outcome.promotionId, targets[0].runId);
  await ended(targets[0].runId);
  assert.deepEqual(targetInputs(), [{ prompt: "next" }]);
  assert.deepEqual(completed.budget, { limit: 1, spent: 1 });
} finally { await daemon.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-182 a lost busy reply recovers in the live daemon when the target becomes idle", () =>
  withConsumer(
    workflow
      .replaceAll('workflowId: "B"', 'workflowId: "develop-issue"')
      .replace("input: input.input", 'input: { ticket: "CLV-901" }')
      .replace(
        "JSON.stringify(input.input)",
        "JSON.stringify({ ticket: input.ticketId })",
      ),
    async (consumer) => {
      const result = await consumer.run(
        `${prelude}
const { default: net } = await import("node:net");
const connect = net.connect.bind(net);
let lost = false;
net.connect = (...argumentsList) => {
  const socket = connect(...argumentsList);
  const emit = socket.emit.bind(socket);
  let buffered = "";
  socket.emit = (event, ...given) => {
    if (event !== "data" || lost) return emit(event, ...given);
    buffered += String(given[0]);
    if (!buffered.includes("\\n")) return emit(event, ...given);
    const reply = JSON.parse(buffered.split("\\n")[0]);
    if (reply.error?.code !== "workflow-active") return emit(event, ...given);
    lost = true;
    socket.destroy();
    rmSync("hold-target");
    return true;
  };
  return socket;
};
settings.declarations[0].handoffs = ["develop-issue"];
settings.manifests.developTicket = settings.manifests.b;
settings.workflows.developTicket = workflows.b;
settings.queueMilliseconds = 1000;
settings.concurrency = 2;
writeFileSync("hold-target", "");
const daemon = await launched();
try {
  const active = await submitted("active");
  const source = await submitA();
  await until(() => lost);
  await ended(active.runId);
  const completed = await ended(source.runId);
  assert.equal(lost, true);
  assert.equal(completed.outcome?.kind, "handoff_requested", JSON.stringify(completed));
  const targets = (await runs()).filter((run) => run.workflowId === "develop-issue" && run.runId !== active.runId);
  assert.equal(targets.length, 1);
  assert.equal(completed.outcome.promotionId, targets[0].runId);
  await ended(targets[0].runId);
  assert.deepEqual(targetInputs(), [{ ticket: "CLV-900" }, { ticket: "CLV-901" }]);
} finally { await daemon.close(); }
`,
        { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "2" },
      );
      assert.equal(result.status, 0, result.stderr);
    },
  ));

await test("CLV-182 a daemon crash after B admission but before its submission reply reuses B", () =>
  withConsumer(workflow, async (consumer) => {
    const first = await consumer.runUntil(
      "handoff-reply-lost",
      `${prelude}${lostReply}`,
    );
    const boundary: unknown = first.lines[0];
    assert.equal(
      Reflect.get(Object(boundary), "boundary"),
      "handoff-reply-lost",
      first.stderr,
    );
    assert.equal(Reflect.get(Object(boundary), "resultSaved"), false);
    const recovered = await consumer.run(`${prelude}
rmSync("hold-target");
const daemon = await launched();
try {
  const source = await submitA();
  const completed = await ended(source.runId);
  const targets = (await runs()).filter((run) => run.workflowId === "B");
  assert.equal(targets.length, 1);
  assert.equal(completed.outcome?.promotionId, targets[0].runId);
  await ended(targets[0].runId);
  assert.deepEqual(targetInputs(), [{ prompt: "next" }]);
  print({ targetRunId: targets[0].runId });
} finally { await daemon.close(); }
`);
    assert.equal(recovered.status, 0, recovered.stderr);
    const targetRunId: unknown = Reflect.get(Object(boundary), "targetRunId");
    assert.deepEqual(recovered.lines, [{ targetRunId }]);
  }));

for (const [name, setup, reason] of [
  [
    "undeclared target",
    "settings.declarations[0].handoffs = [];",
    "handoff-not-declared",
  ],
  [
    "refused input",
    'settings.declarations[1].input.fields = { ticket: { type: "string" } };',
    "handoff-input-refused",
  ],
] as const)
  await test(`CLV-182 compiled handoff refuses ${name} without starting B`, () =>
    withConsumer(workflow, async (consumer) => {
      const result = await consumer.run(`${prelude}
${setup}
const daemon = await launched();
try {
  const source = await submitA();
  const completed = await ended(source.runId);
  assert.equal(completed.outcome?.kind, "blocked");
  assert.ok(completed.outcome.reason.includes(${JSON.stringify(reason)}), JSON.stringify(completed));
  assert.equal((await runs()).filter((run) => run.workflowId === "B").length, 0);
  assert.deepEqual(targetInputs(), []);
} finally { await daemon.close(); }
`);
      assert.equal(result.status, 0, result.stderr);
    }));

await test("CLV-182 separate handoff calls to B use distinct operation IDs", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${prelude}
settings.declarations[0].effectLimit = 2;
const restarted = await launched();
try {
  const source = await submitted("twice", { workflowId: "A", source: "input", submission: { prompt: "twice" } });
  const completed = await ended(source.runId);
  const targets = (await runs()).filter((run) => run.workflowId === "B");
  assert.equal(targets.length, 2, JSON.stringify(completed));
  assert.ok(targets.some((run) => run.runId === completed.outcome?.promotionId));
  await Promise.all(targets.map((run) => ended(run.runId)));
  assert.deepEqual(targetInputs(), [{ prompt: "twice" }, { prompt: "twice" }]);
  assert.deepEqual(completed.budget, { limit: 2, spent: 2 });
} finally { await restarted.close(); }
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-182 process crash before the handoff checkpoint returns the same B run without a second start", () =>
  withConsumer(workflow, async (consumer) => {
    const first = await consumer.runUntil(
      "before-handoff-checkpoint",
      `${prelude}
writeFileSync("hold-target", "");
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType === "step_completed") {
    const targets = (await runs()).filter((run) => run.workflowId === "B");
    return await halt("before-handoff-checkpoint", { targetRunId: targets[0].runId });
  }
  return await create(...given);
};
await launched();
await submitA();
await new Promise(() => undefined);
`,
    );
    const boundary: unknown = first.lines[0];
    assert.equal(
      Reflect.get(Object(boundary), "boundary"),
      "before-handoff-checkpoint",
      first.stderr,
    );
    const recovered = await consumer.run(`${prelude}
rmSync("hold-target");
const daemon = await launched();
try {
  const source = await submitA();
  const completed = await ended(source.runId);
  const targets = (await runs()).filter((run) => run.workflowId === "B");
  assert.equal(targets.length, 1);
  assert.equal(completed.outcome?.promotionId, targets[0].runId);
  await ended(targets[0].runId);
  assert.deepEqual(targetInputs(), [{ prompt: "next" }]);
  print({ targetRunId: targets[0].runId });
} finally { await daemon.close(); }
`);
    assert.equal(recovered.status, 0, recovered.stderr);
    const targetRunId: unknown = Reflect.get(Object(boundary), "targetRunId");
    assert.deepEqual(recovered.lines, [{ targetRunId }]);
  }));
