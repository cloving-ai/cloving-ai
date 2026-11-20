import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { appendFileSync } from "node:fs";

export async function outcome(cycleId: string) {
  "use step";
  appendFileSync("step-starts", "start\\n");
  return { kind: "handoff_requested", cycleId, promotionId: "promotion-1" };
}

export async function develop(input: { cycleId: string }) {
  "use workflow";
  return await outcome(input.cycleId);
}
`;

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function stoppedAt(window: string): string {
  return `
const window = ${JSON.stringify(window)};
const world = await getWorld();
const create = world.events.create.bind(world.events);
const stop = () => {
  print({ boundary: window });
  process.kill(process.pid, "SIGKILL");
};
world.events.create = async (runId, data, ...rest) => {
  if (window === "before-" + data?.eventType) stop();
  const result = await create(runId, data, ...rest);
  if (window === "after-" + data?.eventType) stop();
  return result;
};
const service = await hosted();
await submitted("c-1");
await delay(20000);
`;
}

const restarted = `
const service = await hosted();
const world = await getWorld();
const runs = await tagged();
const reached = async () => (await stateOf(runs[0].run)) === "completed";
for (let pass = 0; pass < 400 && !(await reached()); pass += 1) await delay(20);
const list = () => world.events.list({ runId: runs[0].receipt, pagination: { limit: 200, sortOrder: "asc" }, resolveData: "none" });
let listed = await list();
for (let pass = 0; pass < 100 && listed.data.at(-1)?.eventType !== "run_completed"; pass += 1) { await delay(20); listed = await list(); }
print({
  state: await stateOf(runs[0].run),
  starts: stepStarts(),
  events: listed.data.map((event) => event.eventType).filter((type) => type.startsWith("step_")),
  last: listed.data.at(-1)?.eventType,
  files: readdirSync(dataDirectory).filter((name) => [".locks", "steps", "events", "runs"].includes(name)),
});
await service.close();
process.exit(0);
`;

async function recovered(window: string): Promise<readonly unknown[]> {
  return await withConsumer(workflows, async (consumer) => {
    const first = await consumer.run(servicePrelude + stoppedAt(window), {
      NODE_V8_COVERAGE: undefined,
    });
    const second = await consumer.run(servicePrelude + restarted);
    const [line] = second.lines;
    return [
      field(first.lines[0], "boundary"),
      field(line, "state"),
      field(line, "starts"),
      field(line, "events"),
      field(line, "last"),
      field(line, "files"),
    ];
  });
}

await test("#852 after a process stop between the start record of a step and the run of its body, the next host on the SQLite World runs the step and the run completes", async () => {
  assert.deepEqual(await recovered("before-step_started"), [
    "before-step_started",
    "completed",
    1,
    ["step_created", "step_started", "step_completed"],
    "run_completed",
    [],
  ]);
  assert.deepEqual(await recovered("after-step_started"), [
    "after-step_started",
    "completed",
    1,
    [
      "step_created",
      "step_started",
      "step_retrying",
      "step_started",
      "step_completed",
    ],
    "run_completed",
    [],
  ]);
});

await test("#852 after a process stop between the end of a step body and its end record, or after the end record, the next host on the SQLite World completes the run", async () => {
  assert.deepEqual(await recovered("before-step_completed"), [
    "before-step_completed",
    "completed",
    2,
    [
      "step_created",
      "step_started",
      "step_retrying",
      "step_started",
      "step_completed",
    ],
    "run_completed",
    [],
  ]);
  assert.deepEqual(await recovered("after-step_completed"), [
    "after-step_completed",
    "completed",
    1,
    ["step_created", "step_started", "step_completed"],
    "run_completed",
    [],
  ]);
});
