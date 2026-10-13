import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export async function outcome(cycleId: string) {
  "use step";
  appendFileSync("step-starts", "start\\n");
  while (existsSync("hold")) await delay(10);
  return { kind: "handoff_requested", cycleId, promotionId: "promotion-1" };
}

export async function develop(input: { cycleId: string }) {
  "use workflow";
  return await outcome(input.cycleId);
}

export async function plain() {
  "use workflow";
  return "done";
}
`;

const completedRun = [
  "run.created",
  "step.dispatched",
  "run.started",
  "run.completed",
];

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function oneWorldRun(run: {
  readonly runId: unknown;
  readonly receipt: unknown;
  readonly status: string;
}): unknown {
  return {
    run: run.runId,
    operation: `["cloving-operation",0,${JSON.stringify(run.runId)},"admission","start-run",null,null]`,
    receipt: run.receipt,
    status: run.status,
  };
}

const restarted = `
const service = await hosted();
const runId = process.env.RUN_ID;
await until(async () => (await stateOf(runId)) === "completed");
print({ types: await eventTypes(runId), world: await tagged(), dispatches: await dispatches(runId), calls });
await service.close();
`;

await test("CLV-056 a run that the service admits starts one World run through the product host, and the World progress gives the started and the completed transition", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
const service = await hosted();
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "completed");
const types = await eventTypes(runId);
const world = await tagged();
print({ runId, types, world, dispatches: await dispatches(runId), calls, outcome: await outcomeKind(world[0].receipt) });
await service.close();
`);
    assert.equal(result.lines.length, 1, result.stderr);
    const [line] = result.lines;
    const runId = field(line, "runId");
    const [receipt] = items(field(line, "dispatches"));
    assert.deepEqual(line, {
      runId,
      types: completedRun,
      world: [oneWorldRun({ runId, receipt, status: "completed" })],
      dispatches: [receipt],
      calls: ["reconcile absent", "deliver"],
      outcome: "handoff_requested",
    });
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-056 a run in the queue before a crash starts one time after the restart, and the service reconciles before the dispatch", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-before-send",
      `${servicePrelude}
let announced;
const known = new Promise((resolve) => { announced = resolve; });
const service = await hosted({ wrap: (product) => ({ ...product, deliver: async () => { await known; return await halt("halted-before-send", { world: await tagged() }); } }) });
print({ runId: await submitted("c-1") });
announced();
`,
    );
    const runId = field(first.lines[0], "runId");
    assert.deepEqual(first.lines[1], {
      boundary: "halted-before-send",
      world: [],
    });
    const second = await consumer.run(servicePrelude + restarted, {
      RUN_ID: String(runId),
    });
    const [receipt] = items(field(second.lines[0], "dispatches"));
    assert.deepEqual(second.lines, [
      {
        types: completedRun,
        world: [oneWorldRun({ runId, receipt, status: "completed" })],
        dispatches: [receipt],
        calls: ["reconcile absent", "deliver"],
      },
    ]);
  }));

await test("CLV-056 a crash inside start() leaves at most one World run for the start operation after the restart", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-inside-start",
      `${servicePrelude}
const service = await hosted();
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  if (given[1]?.eventType !== "run_created") return await create(...given);
  await create(...given).catch(() => undefined);
  return await halt("halted-inside-start", { runId: given[1].eventData.attributes["cloving.run"], world: await tagged() });
};
await submitted("c-1");
`,
    );
    const [halted] = first.lines;
    const runId = field(halted, "runId");
    const [written] = items(field(halted, "world"));
    const receipt = field(written, "receipt");
    assert.deepEqual(field(halted, "world"), [
      oneWorldRun({ runId, receipt, status: String(field(written, "status")) }),
    ]);
    assert.match(String(field(written, "status")), /^(pending|running)$/);
    const second = await consumer.run(servicePrelude + restarted, {
      RUN_ID: String(runId),
    });
    assert.deepEqual(second.lines, [
      {
        types: completedRun,
        world: [oneWorldRun({ runId, receipt, status: "completed" })],
        dispatches: [receipt],
        calls: ["reconcile accepted"],
      },
    ]);
  }));

await test("CLV-056 a crash before or after the authority commit of the dispatch record leaves at most one World run, and the restart records the first receipt", () =>
  withConsumer(workflows, async (consumer) => {
    const before = await consumer.runUntil(
      "halted-before-record",
      `${servicePrelude}
let announced;
const known = new Promise((resolve) => { announced = resolve; });
const service = await hosted({ wrap: (product) => ({ ...product, deliver: async (intent) => { const started = await product.deliver(intent); await known; return await halt("halted-before-record", { receipt: started.receipt }); } }) });
print({ runId: await submitted("c-1") });
announced();
`,
    );
    const runId = field(before.lines[0], "runId");
    const receipt = field(before.lines[1], "receipt");
    const after = await consumer.runUntil(
      "halted-after-record",
      `${servicePrelude}
const service = await hosted();
const runId = process.env.RUN_ID ?? ${JSON.stringify(String(runId))};
await until(async () => (await dispatches(runId)).length > 0);
await halt("halted-after-record", { dispatches: await dispatches(runId), calls });
`,
    );
    assert.deepEqual(after.lines, [
      {
        boundary: "halted-after-record",
        dispatches: [receipt],
        calls: ["reconcile accepted"],
      },
    ]);
    const last = await consumer.run(servicePrelude + restarted, {
      RUN_ID: String(runId),
    });
    assert.deepEqual(last.lines, [
      {
        types: completedRun,
        world: [oneWorldRun({ runId, receipt, status: "completed" })],
        dispatches: [receipt],
        calls: [],
      },
    ]);
  }));

await test("CLV-056 a second recovery enqueue of a World run adds no World run", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "in-work",
      `${servicePrelude}
writeFileSync("hold", "");
const service = await hosted();
const runId = await submitted("c-1");
await until(() => stepStarts() === 1);
await halt("in-work", { runId, world: await tagged() });
`,
    );
    const runId = field(first.lines[0], "runId");
    const [written] = items(field(first.lines[0], "world"));
    const receipt = field(written, "receipt");
    const second = await consumer.runUntil(
      "in-work-again",
      `${servicePrelude}
const service = await hosted();
await until(() => stepStarts() === 2);
await halt("in-work-again", { world: await tagged(), dispatches: await dispatches(${JSON.stringify(String(runId))}) });
`,
    );
    assert.deepEqual(second.lines, [
      {
        boundary: "in-work-again",
        world: [oneWorldRun({ runId, receipt, status: "running" })],
        dispatches: [receipt],
      },
    ]);
    const third = await consumer.run(
      `${servicePrelude}
rmSync("hold");
const service = await hosted();
const runId = process.env.RUN_ID;
await until(async () => (await stateOf(runId)) === "completed");
print({ types: await eventTypes(runId), world: await tagged(), dispatches: await dispatches(runId), calls, starts: stepStarts() });
await service.close();
`,
      { RUN_ID: String(runId) },
    );
    assert.deepEqual(third.lines, [
      {
        types: completedRun,
        world: [oneWorldRun({ runId, receipt, status: "completed" })],
        dispatches: [receipt],
        calls: [],
        starts: 3,
      },
    ]);
  }));

await test("CLV-056 the reader of the World runs gives each tagged run of each page, and it gives no run that has no tag", () =>
  withConsumer(workflows, async (consumer) => {
    const read = await consumer.run(`${servicePrelude}
const opening = await startHost({ dataDirectory, concurrency: 1, handler: POST });
const started = [];
for (const name of ["a", "b", "c", "d", "e"])
  started.push(await start(workflows.develop, [{ cycleId: name }], { attributes: { "cloving.run": "run-" + name, "cloving.operation": "operation-" + name } }));
const untagged = await start(workflows.plain, []);
const half = await start(workflows.develop, [{ cycleId: "f" }], { attributes: { "cloving.run": "run-f" } });
for (const run of [...started, untagged, half]) await getRun(run.runId).returnValue;
const paged = await taggedRuns(2);
print({
  paged: paged.map((run) => [run.runId, run.operationId, run.status]).sort(),
  whole: (await taggedRuns()).length,
  kinds: [await outcomeKind(started[0].runId) ?? null, await outcomeKind(untagged.runId) ?? null],
});
await opening.host.close();
`);
    assert.deepEqual(read.lines, [
      {
        paged: [
          ...["a", "b", "c", "d", "e"].map((name) => [
            `run-${name}`,
            `operation-${name}`,
            "completed",
          ]),
          ["run-f", null, "completed"],
        ],
        whole: 6,
        kinds: ["handoff_requested", null],
      },
    ]);
  }));
