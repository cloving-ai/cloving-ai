import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export async function double(value: number) {
  "use step";
  await delay(150);
  return value * 2;
}

export async function develop(input: { value: number }) {
  "use workflow";
  return { doubled: await double(input.value) };
}

export async function hold(directory: string) {
  "use step";
  writeFileSync(directory + "/step-started", "");
  while (!existsSync(directory + "/release")) await delay(10);
  writeFileSync(directory + "/step-ended", "");
  return "ended";
}

export async function held(input: { directory: string }) {
  "use workflow";
  return await hold(input.directory);
}
`;

const opened = `
const opening = await startHost({ dataDirectory, concurrency: Number(process.env.BOUND ?? "1"), handler: counted });
if (opening.kind !== "started") { print(opening); process.exit(0); }
`;

const counting = `
let inWork = 0;
let most = 0;
const counted = async (request) => {
  inWork += 1;
  most = Math.max(most, inWork);
  try { return await POST(request); } finally { inWork -= 1; }
};
`;

const threeRuns = `${counting}${opened}
const runs = await Promise.all([1, 2, 3].map((value) => start(workflows.develop, [{ value }])));
const results = await Promise.all(runs.map((run) => getRun(run.runId).returnValue));
await opening.host.close();
print({ kind: opening.kind, results, most });
`;

await test("CLV-055 the product host starts the real Local World, runs one compiled workflow to its end and closes", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${counting}${opened}
const run = await start(workflows.develop, [{ value: 2 }]);
const result = await getRun(run.runId).returnValue;
await opening.host.close();
print({ kind: opening.kind, result, runs: readdirSync(dataDirectory + "/runs").length, world: worlds() > 0 });
`);
    assert.deepEqual(result.lines, [
      { kind: "started", result: { doubled: 4 }, runs: 1, world: true },
    ]);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-055 the product host refuses to start with no explicit concurrency bound, and with the bound 1 it runs one workflow message at a time", () =>
  withConsumer(workflows, async (consumer) => {
    for (const [environment, reason] of [
      [{ WORKFLOW_LOCAL_QUEUE_CONCURRENCY: undefined }, "host-bound"],
      [{ WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "2" }, "host-bound"],
      [
        { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "0", BOUND: "0" },
        "invalid-host-bound",
      ],
      [
        { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "1.5", BOUND: "1.5" },
        "invalid-host-bound",
      ],
      [
        { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "1e+21", BOUND: "1e21" },
        "invalid-host-bound",
      ],
      [
        { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "65", BOUND: "65" },
        "invalid-host-bound",
      ],
    ] as const) {
      const refusal = await consumer.run(threeRuns, environment);
      assert.partialDeepStrictEqual(refusal.lines, [
        { kind: "refused", reason },
      ]);
      assert.equal(existsSync(consumer.world), false);
    }
    const one = await consumer.run(threeRuns);
    assert.deepEqual(one.lines, [
      {
        kind: "started",
        results: [{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }],
        most: 1,
      },
    ]);
    const three = await consumer.run(threeRuns, {
      WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "3",
      BOUND: "3",
    });
    assert.partialDeepStrictEqual(three.lines, [{ kind: "started", most: 3 }]);
  }));

await test("CLV-055 the product host refuses a World that is not the Local World of its data directory", () =>
  withConsumer(workflows, async (consumer) => {
    for (const environment of [
      { WORKFLOW_TARGET_WORLD: undefined },
      { WORKFLOW_TARGET_WORLD: "vercel" },
      { WORKFLOW_LOCAL_DATA_DIR: undefined },
      { WORKFLOW_LOCAL_DATA_DIR: join(consumer.directory, "second") },
    ]) {
      const refusal = await consumer.run(
        `${counting}const opening = await startHost({ dataDirectory: ${JSON.stringify(consumer.world)}, concurrency: 1, handler: counted }); print(opening);`,
        environment,
      );
      assert.partialDeepStrictEqual(refusal.lines, [
        { kind: "refused", reason: "host-world" },
      ]);
      assert.deepEqual(
        readdirSync(consumer.directory).filter((name) =>
          ["world", "second", ".workflow-data"].includes(name),
        ),
        [],
      );
    }
    const foreign = await consumer.run(
      `${counting}setWorld({ specVersion: 8 }); print(await startHost({ dataDirectory, concurrency: 1, handler: counted }));
const registered = []; setWorld({ specVersion: 8, registerHandler: (prefix) => registered.push(prefix) });
const opening = await startHost({ dataDirectory, concurrency: 1, handler: counted });
await opening.host.close(); print({ kind: opening.kind, registered });`,
    );
    assert.partialDeepStrictEqual(foreign.lines, [
      { kind: "refused", reason: "host-world" },
      { kind: "started", registered: ["__wkf_workflow_"] },
    ]);
  }));

await test("CLV-055 when the World does not start, the product host closes the World and gives a refusal", () =>
  withConsumer(workflows, async (consumer) => {
    const failed = await consumer.run(
      `${counting}const calls = [];
setWorld({ specVersion: 8, registerHandler: () => calls.push("register"), start: async () => { calls.push("start"); throw new Error("the data directory is not writable"); }, close: async () => { calls.push("close"); } });
print({ opening: await startHost({ dataDirectory, concurrency: 1, handler: counted }), calls });`,
    );
    assert.deepEqual(failed.lines, [
      {
        opening: {
          kind: "refused",
          reason: "host-start-failed",
          detail: "the data directory is not writable",
        },
        calls: ["register", "start", "close"],
      },
    ]);
  }));

await test("CLV-057 a cancel of a World run that is at an end gives the end status and throws no error", () =>
  withConsumer(workflows, async (consumer) => {
    const ended = await consumer.run(`${counting}${opened}
const { cancelled } = await import(${JSON.stringify(join(import.meta.dirname, "../src/host/world-runs.ts"))});
const run = await start(workflows.develop, [{ value: 2 }]);
await getRun(run.runId).returnValue;
print({ status: await cancelled(run.runId) });
await opening.host.close();
`);
    assert.deepEqual(ended.lines, [{ status: "completed" }]);
  }));

await test("CLV-055 an import of the package entries and of the host module starts no World and writes no file", () =>
  withConsumer(workflows, async (consumer) => {
    const entries = (): string[] =>
      readdirSync(consumer.directory)
        .filter((name) => name !== "scenario.mjs")
        .sort();
    const before = entries();
    const imported = await consumer.run(
      `import * as entry from ${JSON.stringify(join(import.meta.dirname, "../src/workflows.ts"))};
import * as step from ${JSON.stringify(join(import.meta.dirname, "../src/steps/load-cycle.ts"))};
print({ entries: [typeof entry.loadCycle, typeof step.loadCycle, typeof startHost], worlds: worlds() });`,
    );
    assert.deepEqual(imported.lines, [
      { entries: ["function", "function", "function"], worlds: 0 },
    ]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(entries(), before);
  }));

await test("CLV-055 a close of the host does not stop a step in work and records no stop of its run", () =>
  withConsumer(workflows, async (consumer) => {
    const closed = await consumer.run(`${counting}${opened}
const directory = process.cwd();
const run = await start(workflows.held, [{ directory }]);
while (!existsSync(directory + "/step-started")) await delay(10);
await opening.host.close();
const stopped = () => ["cancelled", "failed", "completed"].includes(JSON.parse(readFileSync(dataDirectory + "/runs/" + run.runId + ".json", "utf8")).status);
const atClose = { ended: existsSync(directory + "/step-ended"), stopped: stopped() };
await delay(200);
const later = { ended: existsSync(directory + "/step-ended"), stopped: stopped() };
writeFileSync(directory + "/release", "");
while (!existsSync(directory + "/step-ended")) await delay(10);
print({ atClose, later, endedAfterRelease: true });
process.exit(0);
`);
    assert.deepEqual(closed.lines, [
      {
        atClose: { ended: false, stopped: false },
        later: { ended: false, stopped: false },
        endedAfterRelease: true,
      },
    ]);
  }));
