import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  productRoot,
  servicePrelude,
  withConsumer,
} from "./world-host-fixture.ts";

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function develop(input: { cycleId: string }) {
  "use workflow";
  const effect = await protectedEffect({
    scope: { phase: "work", operation: "effect", round: 1 },
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: "build the package for " + input.cycleId,
    units: input.cycleId === "cycle-2" ? 9 : 1,
  });
  return { kind: "handoff_requested", cycleId: input.cycleId, effect };
}
`;

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function operationOf(runId: unknown): string {
  return `["cloving-operation",1,${JSON.stringify(runId)},"work","effect",null,null]`;
}

const effects = `
const shownRun = async (runId) => (await asked("status", { runId })).run;
const summary = async (runId) => {
  const run = await shownRun(runId);
  const world = await tagged();
  return {
    state: run.state,
    budget: run.budget,
    effects: run.effects.map((effect) => [effect.operationId, effect.state, effect.attempts]),
    sends: lines("destination.log"),
    reconciles: lines("reconciles.log").length,
    requests: lines("requests.log").map((line) => JSON.parse(line)),
    output: world.length === 1 && world[0].status === "completed" ? (await getRun(world[0].receipt).returnValue).effect : null,
  };
};
`;

await test("CLV-058 a compiled workflow step requests a protected effect through the product host, the fake destination gets one send, and the step result has the stored receipt", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${effects}
const service = await hosted();
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "completed");
print({ runId, ...(await summary(runId)) });
await service.close();
`);
    const [line] = result.lines;
    const operationId = operationOf(field(line, "runId"));
    assert.deepEqual(line, {
      runId: field(line, "runId"),
      state: "completed",
      budget: { limit: 5, spent: 1 },
      effects: [[operationId, "completed", 0]],
      sends: [operationId],
      reconciles: 1,
      requests: field(line, "requests"),
      output: {
        kind: "completed",
        operationId,
        receipt: "receipt-1",
        result: "effect-result",
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }));

function completedEffect(operationId: string): unknown {
  return {
    kind: "completed",
    operationId,
    receipt: "receipt-1",
    result: "effect-result",
  };
}

const restarted = `
const service = await hosted();
const runId = process.env.RUN_ID;
await until(async () => (await stateOf(runId)) === "completed");
const ended = await summary(runId);
await service.close();
print({ ...ended, rows: deliveryRows(ended.effects[0][0]) });
`;

function requests(line: unknown): readonly (readonly unknown[])[] {
  const list: unknown = field(line, "requests");
  return Array.isArray(list) ? list.map((item: unknown) => items(item)) : [];
}

await test("CLV-058 an SDK retry and a native redelivery after a fake success, before the SDK checkpoint, keep one operation ID, one input digest and one logical effect", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-after-effect",
      `${servicePrelude}${effects}
writeFileSync("halt-after-effect", "");
const service = await hosted();
print({ runId: await submitted("c-1") });
`,
    );
    const runId = String(field(first.lines[0], "runId"));
    assert.deepEqual(first.lines[1], {
      boundary: "halted-after-effect",
      sends: 1,
    });
    const second = await consumer.run(
      `${servicePrelude}${effects}
rmSync("halt-after-effect");
${restarted}`,
      { RUN_ID: runId },
    );
    const [line] = second.lines;
    const operationId = operationOf(runId);
    assert.deepEqual(field(line, "sends"), [operationId]);
    assert.deepEqual(field(line, "output"), completedEffect(operationId));
    assert.deepEqual(field(line, "budget"), { limit: 5, spent: 1 });
    const asked = requests(line);
    assert.equal(asked.length >= 2, true, JSON.stringify(asked));
    assert.deepEqual(
      [...new Set(asked.map((request) => request[0]))],
      [operationId],
    );
    assert.equal(new Set(asked.map((request) => request[1])).size, 1);
    assert.equal(Number(field(line, "reconciles")) >= 2, true);
    assert.deepEqual(
      asked.map((request) => String(request[2]).slice(-2)),
      [":1", ":2"],
    );
    assert.deepEqual(field(line, "rows"), [["completed", "receipt-1"]]);
  }));

function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

await test("CLV-058 a result that the authority committed before the SDK checkpoint returns to the SDK retry with no adapter call, and the retry uses no second unit of the run budget", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-before-checkpoint",
      `${servicePrelude}${effects}
writeFileSync("halt-at-checkpoint", "");
const service = await hosted();
await checkpointBarrier();
print({ runId: await submitted("c-1") });
`,
    );
    const runId = String(field(first.lines[0], "runId"));
    assert.deepEqual(first.lines[1], {
      boundary: "halted-before-checkpoint",
      sends: 1,
      reconciles: 1,
    });
    const second = await consumer.run(
      `${servicePrelude}${effects}
rmSync("halt-at-checkpoint");
${restarted}`,
      { RUN_ID: runId },
    );
    const [line] = second.lines;
    const operationId = operationOf(runId);
    assert.deepEqual(
      [field(line, "sends"), field(line, "reconciles"), field(line, "budget")],
      [[operationId], 1, { limit: 5, spent: 1 }],
    );
    assert.deepEqual(field(line, "output"), completedEffect(operationId));
    assert.deepEqual(field(line, "effects"), [[operationId, "completed", 0]]);
    assert.deepEqual(field(line, "rows"), [["completed", "receipt-1"]]);
    const asked = requests(line);
    assert.equal(asked.length, 2, JSON.stringify(asked));
    assert.equal(new Set(asked.map((request) => request[1])).size, 1);
  }));

await test("CLV-058 a refused request returns a typed result to the workflow and sends nothing", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${effects}
const service = await hosted();
const first = await submitted("c-1");
await until(async () => (await stateOf(first)) === "completed");
const second = await submitted("c-2");
await until(async () => (await stateOf(second)) === "completed");
const world = (await tagged()).find((run) => run.run === second);
print({ sends: lines("destination.log").length, effect: (await getRun(world.receipt).returnValue).effect, budget: (await shownRun(second)).budget });
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        sends: 1,
        effect: { kind: "refused", reason: "budget-exhausted" },
        budget: { limit: 5, spent: 0 },
      },
    ]);
  }));

await test("CLV-058 the step module has an explicit package export, the public entry exports the same function, and the compiled step has a versioned identity", () =>
  withConsumer(workflows, async (consumer) => {
    const manifest: unknown = JSON.parse(
      await readFile(join(productRoot, "package.json"), "utf8"),
    );
    assert.deepEqual(
      field(field(manifest, "exports"), "./workflows/steps/protected-effect"),
      {
        types: "./dist/src/steps/protected-effect.d.ts",
        import: "./dist/src/steps/protected-effect.js",
      },
    );
    assert.match(
      await readFile(join(productRoot, "src/workflows.ts"), "utf8"),
      /export \{ protectedEffect \} from "\.\/steps\/protected-effect\.ts";/,
    );
    const compiled = await readFile(
      join(consumer.directory, "artifacts/manifest.json"),
      "utf8",
    );
    assert.equal(
      compiled.includes(
        `step//cloving/workflows/steps/protected-effect@${String(field(manifest, "version"))}//protectedEffect`,
      ),
      true,
      compiled.slice(0, 600),
    );
  }));

await test("CLV-058 an unknown outcome that the destination cannot reconcile blocks a second send when the SDK tries the step again", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-before-checkpoint",
      `${servicePrelude}${effects}
for (const name of ["lose-reply", "not-idempotent", "halt-at-checkpoint"]) writeFileSync(name, "");
const service = await hosted();
await checkpointBarrier();
print({ runId: await submitted("c-1") });
`,
    );
    const runId = String(field(first.lines[0], "runId"));
    assert.equal(field(first.lines[1], "sends"), 1);
    const second = await consumer.run(
      `${servicePrelude}${effects}
rmSync("halt-at-checkpoint");
${restarted}`,
      { RUN_ID: runId },
    );
    const [line] = second.lines;
    const operationId = operationOf(runId);
    assert.deepEqual(field(line, "sends"), [operationId]);
    const [effect] = items(field(line, "effects"));
    assert.deepEqual(items(effect).slice(0, 2), [operationId, "blocked"]);
    assert.equal(Number(items(effect)[2]) >= 3, true);
    assert.deepEqual(field(line, "output"), {
      kind: "blocked",
      operationId,
      reason: "outcome-unknown",
    });
    assert.deepEqual(field(line, "budget"), { limit: 5, spent: 1 });
  }));
