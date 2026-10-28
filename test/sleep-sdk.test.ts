import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";

for (const [module, seconds] of [
  ["cloving/workflows", 1],
  ["cloving/workflows/steps/sleep", 86400],
] as const)
  await test(`CLV-233 compiled ${module} persists a ${String(seconds)} second SDK wait without a step`, () =>
    withConsumer(
      `import { sleep } from "${module}";
export async function develop() {
  "use workflow";
  await sleep({ seconds: ${String(seconds)} });
  return "awake";
}`,
      async (consumer) => {
        const result = await consumer.runUntil(
          "sleep-persisted",
          `
import { mock } from "node:test";
mock.timers.enable({ apis: ["Date"], now: Date.now() });
const host = await startHost({ dataDirectory, concurrency: 1, handler: POST });
if (host.kind !== "started") throw new Error(host.reason);
const world = await getWorld();
const create = world.events.create.bind(world.events);
world.events.create = async (...given) => {
  const created = await create(...given);
  if (given[1]?.eventType === "wait_created")
    await halt("sleep-persisted", { wait: created.event, waits: (await world.events.list({ runId: given[0] })).data.filter(event => event.eventType === "wait_created"), steps: (await world.steps.list({ runId: given[0], resolveData: "none" })).data });
  return created;
};
await start(workflows.develop, []);
await new Promise(() => undefined);
`,
        );
        const entry = result.lines[0];
        assert.ok(entry && typeof entry === "object", result.stderr);
        assert.ok("wait" in entry && "steps" in entry && "waits" in entry);
        assert.deepEqual(entry.steps, []);
        assert.ok(Array.isArray(entry.waits));
        assert.equal(entry.waits.length, 1);
        const wait = entry.wait;
        assert.ok(wait && typeof wait === "object");
        assert.ok("eventData" in wait && "createdAt" in wait);
        const data = wait.eventData;
        assert.ok(data && typeof data === "object" && "resumeAt" in data);
        const duration =
          Date.parse(String(data.resumeAt)) -
          Date.parse(String(wait.createdAt));
        assert.equal(duration, seconds * 1000);
      },
    ));
