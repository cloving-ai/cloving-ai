import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const request = `{
    scope: { phase: "work", operation: "effect", round },
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: "build the package for " + cycleId,
    units: 1,
  }`;

const direct = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function develop(input: { cycleId: string }) {
  "use workflow";
  const cycleId = input.cycleId;
  const round = 1;
  const effect = await protectedEffect(${request});
  return { kind: "handoff_requested", cycleId, effect };
}
`;

const timed = `
import { sleep } from "workflow";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function develop(input: { cycleId: string }) {
  "use workflow";
  const cycleId = input.cycleId;
  const round = 1;
  await sleep("3s");
  const effect = await protectedEffect(${request});
  return { kind: "handoff_requested", cycleId, effect };
}
`;

const segmented = `
import { getWorkflowMetadata } from "workflow";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function ask() {
  "use step";
  return await globalThis.clovingGate(getWorkflowMetadata().workflowRunId);
}

export async function develop(input: { cycleId: string }, continuation?: { gateId: string }) {
  "use workflow";
  const cycleId = input.cycleId;
  const round = continuation === undefined ? 1 : 2;
  const effect = await protectedEffect(${request});
  if (continuation === undefined)
    return { kind: "waiting_for_decision", cycleId, decisionId: await ask(), effect };
  return { kind: "handoff_requested", cycleId, effect };
}
`;

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function operationOf(runId: unknown, round = 1): string {
  return `["cloving-operation",${String(round)},${JSON.stringify(runId)},"work","effect",null,null]`;
}

const effects = `
const shownRun = async (runId) => (await asked("status", { runId })).run;
const summary = async (runId) => {
  const run = await shownRun(runId);
  return {
    state: run.state,
    code: run.reason.code,
    budget: run.budget,
    effects: run.effects.map((effect) => [effect.operationId, effect.state]),
    sends: lines("destination.log"),
    requests: lines("requests.log").map((line) => JSON.parse(line)),
    segments: (await tagged()).length,
  };
};
`;

const finished = `
await until(async () => (await stateOf(runId)) === "completed");
print(await summary(runId));
await service.close();
`;

function unknownOutcome(line: unknown): void {
  const asked = items(field(line, "requests")).map(items);
  const operationId = String(asked[0]?.[0]);
  assert.match(operationId, /"work","effect"/);
  assert.deepEqual(
    asked.map((entry) => entry[3]),
    ["failed", "duplicate"],
  );
  assert.equal(new Set(asked.map((entry) => entry[2])).size, 1);
  assert.deepEqual(
    [field(line, "sends"), field(line, "budget"), field(line, "effects")],
    [[operationId], { limit: 5, spent: 1 }, [[operationId, "completed"]]],
  );
}

await test("CLV-059 after a storage-failure receipt of a protected request, the host bridge sends the same command ID again after the reopen, and the reply has the stored disposition", () =>
  withConsumer(direct, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-after-failed-receipt",
      `${servicePrelude}${effects}
writeFileSync("fail-first-reply", "");
writeFileSync("halt-after-failed", "");
const service = await hosted();
print({ runId: await submitted("c-1") });
`,
    );
    const runId = String(field(first.lines[0], "runId"));
    const second = await consumer.run(
      `${servicePrelude}${effects}
const service = await hosted();
const runId = process.env.RUN_ID;
${finished}`,
      { RUN_ID: runId },
    );
    unknownOutcome(second.lines[0]);
  }));

await test("CLV-059 after a storage-failure receipt with no process stop, the bridge keeps the request and sends the same command ID again", () =>
  withConsumer(direct, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${effects}
writeFileSync("fail-first-reply", "");
const service = await hosted();
const runId = await submitted("c-1");
${finished}`);
    unknownOutcome(result.lines[0]);
  }));

await test("CLV-059 a close of the service while a protected request is in work gives the step no result, and after the reopen the workflow gets the stored result of one send", () =>
  withConsumer(direct, async (consumer) => {
    const first = await consumer.run(`${servicePrelude}${effects}
writeFileSync("hold-request", "");
const service = await hosted();
const runId = await submitted("c-1");
await until(() => existsSync("hold-request-entered"));
await until(async () => (await summary(runId)).effects[0]?.[1] === "completed");
await service.close();
const world = await tagged();
print({ runId: world[0].run, world: world.map((run) => run.status) });
process.exit(0);
`);
    const runId = String(field(first.lines[0], "runId"));
    assert.deepEqual(field(first.lines[0], "world"), ["running"]);
    const second = await consumer.run(
      `${servicePrelude}${effects}
const service = await hosted();
const runId = process.env.RUN_ID;
rmSync("hold-request");
await until(async () => (await stateOf(runId)) === "completed");
print({ ...(await summary(runId)), output: (await segments())[0].output.effect.kind });
await service.close();
`,
      { RUN_ID: runId },
    );
    const [line] = second.lines;
    const asked = items(field(line, "requests")).map(items);
    assert.deepEqual(
      [
        field(line, "output"),
        field(line, "sends"),
        field(line, "budget"),
        field(line, "effects"),
        new Set(asked.map((entry) => entry[2])).size,
        asked.at(-1)?.[3],
      ],
      [
        "completed",
        [operationOf(runId)],
        { limit: 5, spent: 1 },
        [[operationOf(runId), "completed"]],
        1,
        "duplicate",
      ],
    );
  }));

await test("CLV-059 a protected effect after an SDK timer keeps its identity across a restart during the timer", () =>
  withConsumer(timed, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-in-timer",
      `${servicePrelude}${effects}
writeFileSync("hold-timer", "");
const service = await hosted();
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  const created = await create(...given);
  if (given[1]?.eventType === "wait_created") await holdAt("hold-timer");
  return created;
};
const runId = await submitted("c-1");
await until(() => existsSync("hold-timer-entered"));
await halt("halted-in-timer", { runId, sends: lines("destination.log").length });
`,
    );
    const runId = String(field(first.lines[0], "runId"));
    assert.equal(field(first.lines[0], "sends"), 0);
    const second = await consumer.run(
      `${servicePrelude}${effects}
const service = await hosted();
rmSync("hold-timer");
const runId = process.env.RUN_ID;
${finished}`,
      { RUN_ID: runId },
    );
    const [line] = second.lines;
    assert.deepEqual(
      [field(line, "sends"), field(line, "effects"), field(line, "segments")],
      [[operationOf(runId)], [[operationOf(runId), "completed"]], 1],
    );
    assert.equal(items(field(line, "requests")).length, 1);
  }));

await test("CLV-059 a second recovery enqueue of a step in work adds no effect", () =>
  withConsumer(direct, async (consumer) => {
    const first = await consumer.runUntil(
      "in-flight",
      `${servicePrelude}${effects}
writeFileSync("hold-effect", "");
const service = await hosted();
const runId = await submitted("c-1");
await until(() => lines("destination.log").length === 1 && lines("requests.log").length === 1);
await halt("in-flight", { runId });
`,
    );
    const runId = String(field(first.lines[0], "runId"));
    const second = await consumer.runUntil(
      "halted-before-checkpoint",
      `${servicePrelude}${effects}
rmSync("hold-effect");
writeFileSync("halt-at-checkpoint", "");
const service = await hosted();
await checkpointBarrier();
`,
    );
    assert.deepEqual(field(second.lines[0], "sends"), 1);
    const third = await consumer.run(
      `${servicePrelude}${effects}
rmSync("halt-at-checkpoint");
const service = await hosted();
const runId = process.env.RUN_ID;
${finished}`,
      { RUN_ID: runId },
    );
    const [line] = third.lines;
    const asked = items(field(line, "requests")).map(items);
    assert.deepEqual(
      [field(line, "sends"), field(line, "budget"), field(line, "effects")],
      [
        [operationOf(runId)],
        { limit: 5, spent: 1 },
        [[operationOf(runId), "completed"]],
      ],
    );
    assert.equal(asked.length >= 3, true, JSON.stringify(asked));
    assert.equal(new Set(asked.map((entry) => entry[2])).size, 1);
  }));

await test("CLV-059 the run budget of a run is one record across two SDK segments", () =>
  withConsumer(segmented, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${effects}
const service = await hosted();
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "waiting_gate");
const before = (await shownRun(runId)).budget;
await answered(runId);
await until(async () => (await stateOf(runId)) === "completed");
print({ runId, before, ...(await summary(runId)) });
await service.close();
`);
    const [line] = result.lines;
    const runId = field(line, "runId");
    assert.deepEqual(
      [
        field(line, "before"),
        field(line, "budget"),
        field(line, "effects"),
        field(line, "sends"),
        field(line, "segments"),
      ],
      [
        { limit: 5, spent: 1 },
        { limit: 5, spent: 2 },
        [
          [operationOf(runId, 1), "completed"],
          [operationOf(runId, 2), "completed"],
        ],
        [operationOf(runId, 1), operationOf(runId, 2)],
        2,
      ],
    );
  }));

await test("CLV-059 after a drop of a run with a protected effect in flight in an SDK segment, the host gets no new protected dispatch and no continuation", () =>
  withConsumer(direct, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${effects}
writeFileSync("hold-effect", "");
const service = await hosted();
const runId = await submitted("c-1");
await until(() => lines("destination.log").length === 1);
await asked("run-command", { command: "drop", runId, expectedRevision: (await shownRun(runId)).revision, commandId: "c-drop" });
const inFlight = await summary(runId);
rmSync("hold-effect");
await delay(1000);
const after = await summary(runId);
print({ inFlight: [inFlight.state, inFlight.code], after: [after.state, after.sends.length, after.segments, after.effects.map((effect) => effect[1])], stops: calls.filter((call) => call.startsWith("stop")).length });
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        inFlight: ["cancelled", "delivery-in-flight"],
        after: ["cancelled", 1, 1, ["completed"]],
        stops: 1,
      },
    ]);
  }));
