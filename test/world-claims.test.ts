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

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function stoppedAt(window: string): string {
  return `
import { promises as files } from "node:fs";
const window = ${JSON.stringify(window)};
const link = files.link.bind(files);
const rename = files.rename.bind(files);
const seen = [];
const stop = (target) => {
  print({ boundary: window, target: String(target).split("/").at(-1) });
  process.kill(process.pid, "SIGKILL");
};
files.link = async (from, to) => {
  const result = await link(from, to);
  const name = String(to);
  if (!name.includes("/.locks/steps/")) return result;
  const kind = name.split(".").at(-1);
  seen.push(kind);
  if (window === "claim-" + kind) stop(to);
  return result;
};
files.rename = async (from, to) => {
  const result = await rename(from, to);
  const name = String(to);
  if (name.includes("/.locks/") || !name.includes("/steps/")) return result;
  if (window === "entity-" + seen.at(-1)) stop(to);
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
const listed = await world.events.list({ runId: runs[0].receipt, pagination: { limit: 200, sortOrder: "asc" }, resolveData: "none" });
print({
  state: await stateOf(runs[0].run),
  released: globalThis.released,
  events: listed.data.map((event) => event.eventType),
  claims: readdirSync(dataDirectory + "/.locks/steps").filter((name) => !name.includes(".tmp.")).map((name) => name.split(".").at(-1)),
});
await service.close();
process.exit(0);
`;

async function recovered(window: string): Promise<readonly unknown[]> {
  return await withConsumer(workflows, async (consumer) => {
    const first = await consumer.run(servicePrelude + stoppedAt(window));
    const second = await consumer.run(servicePrelude + restarted);
    const [line] = second.lines;
    const stopped = String(field(first.lines[0], "target"));
    return [
      field(first.lines[0], "boundary"),
      field(line, "state"),
      items(field(line, "released")).map((name) =>
        String(name).replace(stopped.replace(/\.[a-z]+$/, ""), "step"),
      ),
      items(field(line, "events")).at(-1),
      field(line, "claims"),
    ];
  });
}

await test("CLV-056 after a process stop between the claim of a step start and its World events, the next host releases the claim and the run completes", async () => {
  assert.deepEqual(await recovered("claim-created"), [
    "claim-created",
    "completed",
    ["step.created"],
    "run_completed",
    ["created", "terminal"],
  ]);
  assert.deepEqual(await recovered("entity-created"), [
    "entity-created",
    "completed",
    ["step.created"],
    "run_completed",
    ["created", "terminal"],
  ]);
});

await test("CLV-056 after a process stop between the claim of a step end and its World event, the next host releases the claim and the run completes", async () => {
  assert.deepEqual(await recovered("claim-terminal"), [
    "claim-terminal",
    "completed",
    ["step.terminal"],
    "run_completed",
    ["created", "terminal"],
  ]);
  assert.deepEqual(await recovered("entity-terminal"), [
    "entity-terminal",
    "completed",
    ["step.terminal"],
    "run_completed",
    ["created", "terminal"],
  ]);
});
