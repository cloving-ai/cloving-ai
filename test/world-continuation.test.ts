import assert from "node:assert/strict";
import { test } from "node:test";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { getWorkflowMetadata } from "workflow";

export async function ask() {
  "use step";
  return await globalThis.clovingGate(getWorkflowMetadata().workflowRunId);
}

export async function finish(continuation: { decision: string; answer: string | null }) {
  "use step";
  while (existsSync("hold")) await delay(10);
  return continuation.decision + ":" + String(continuation.answer);
}

export async function develop(input: { cycleId: string }, continuation?: { gateId: string; decision: string; answer: string | null }) {
  "use workflow";
  if (continuation === undefined)
    return { kind: "waiting_for_decision", cycleId: input.cycleId, decisionId: await ask() };
  return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: continuation.gateId + ":" + (await finish(continuation)) };
}
`;

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function twoSegments(runId: unknown): unknown {
  return [
    {
      kind: "start-run",
      status: "completed",
      output: {
        kind: "waiting_for_decision",
        cycleId: "cycle-1",
        decisionId: `${String(runId)}/design-1`,
      },
    },
    {
      kind: "continue-run",
      status: "completed",
      output: {
        kind: "handoff_requested",
        cycleId: "cycle-1",
        promotionId: "design-1:answered:Use the table parser.",
      },
    },
  ];
}

const waiting = `
const service = await hosted();
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "waiting_gate");
`;

const finished = `
await until(async () => (await stateOf(runId)) === "completed");
await until(async () => (await tagged()).every((run) => run.status === "completed"));
print({ runId, segments: await segments(), dispatches: (await dispatches(runId)).length, calls, reports: (await asked("status", {})).worldReports });
await service.close();
`;

await test("CLV-057 a continuation starts a second SDK segment on the same Cloving run with the typed decision and the answer, and the reconciliation reports no conflict", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${waiting}
const reply = await answered(runId);
if (reply.kind !== "decision-recorded") print({ reply });
${finished}`);
    const [line] = result.lines;
    assert.deepEqual(line, {
      runId: field(line, "runId"),
      segments: twoSegments(field(line, "runId")),
      dispatches: 2,
      calls: ["reconcile absent", "deliver", "reconcile absent", "deliver"],
      reports: [],
    });
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-057 an answer before the wait is delivered to the real SDK run one time after the wait registration", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
writeFileSync("hold-wait", "");${waiting}
await answered(runId);
await delay(400);
print({ before: [(await tagged()).length, sends(), await stateOf(runId)] });
rmSync("hold-wait");
${finished}`);
    assert.deepEqual(result.lines[0], { before: [1, 1, "running"] });
    assert.deepEqual(
      field(result.lines[1], "segments"),
      twoSegments(field(result.lines[1], "runId")),
    );
    assert.deepEqual(field(result.lines[1], "calls"), [
      "reconcile absent",
      "deliver",
      "reconcile absent",
      "deliver",
    ]);
  }));

await test("CLV-057 a duplicate delivery of one continuation adds no second SDK segment, and a restart before the delivery of an acknowledged answer delivers one continuation", () =>
  withConsumer(workflows, async (consumer) => {
    const restarted = `
const service = await hosted();
const runId = process.env.RUN_ID;
${finished}`;
    const halting = (
      boundary: string,
      body: string,
    ): string => `${servicePrelude}
let announced;
const known = new Promise((resolve) => { announced = resolve; });
const wrap = (product) => ({ ...recording(product), deliver: async (intent) => {
  if (intent.kind !== "continue-run") return await product.deliver(intent);
  ${body}
  await known;
  return await halt(${JSON.stringify(boundary)}, { segments: (await tagged()).length });
} });
const service = await hosted({ wrap });
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "waiting_gate");
print({ runId, reply: (await answered(runId)).kind });
announced();
`;
    const sent = await consumer.runUntil(
      "halted-after-continuation",
      halting("halted-after-continuation", "await product.deliver(intent);"),
    );
    assert.deepEqual(sent.lines[1], {
      boundary: "halted-after-continuation",
      segments: 2,
    });
    const runId = String(field(sent.lines[0], "runId"));
    const after = await consumer.run(servicePrelude + restarted, {
      RUN_ID: runId,
    });
    assert.deepEqual(field(after.lines[0], "segments"), twoSegments(runId));
    assert.deepEqual(field(after.lines[0], "calls"), ["reconcile accepted"]);
  }));

await test("CLV-057 a restart before the delivery of an acknowledged answer delivers one continuation after the restart", () =>
  withConsumer(workflows, async (consumer) => {
    const first = await consumer.runUntil(
      "halted-before-continuation",
      `${servicePrelude}
let announced;
const known = new Promise((resolve) => { announced = resolve; });
const wrap = (product) => ({ ...recording(product), deliver: async (intent) => {
  if (intent.kind !== "continue-run") return await product.deliver(intent);
  await known;
  return await halt("halted-before-continuation", { segments: (await tagged()).length });
} });
const service = await hosted({ wrap });
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "waiting_gate");
print({ runId, reply: (await answered(runId)).kind });
announced();
`,
    );
    assert.deepEqual(first.lines[1], {
      boundary: "halted-before-continuation",
      segments: 1,
    });
    const runId = String(field(first.lines[0], "runId"));
    const after = await consumer.run(
      `${servicePrelude}
const service = await hosted();
const runId = process.env.RUN_ID;
${finished}`,
      { RUN_ID: runId },
    );
    assert.deepEqual(field(after.lines[0], "segments"), twoSegments(runId));
    assert.deepEqual(field(after.lines[0], "calls"), [
      "reconcile absent",
      "deliver",
    ]);
  }));

await test("CLV-057 a stale continuation identity resumes no SDK run", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${waiting}
const stale = await answered(runId, { generation: 2, commandId: "c-stale" });
await delay(400);
print({ stale: [stale.kind, stale.code], segments: (await tagged()).length, sends: sends(), state: await stateOf(runId) });
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        stale: ["error", "stale-generation"],
        segments: 1,
        sends: 1,
        state: "waiting_gate",
      },
    ]);
  }));

await test("CLV-057 a drop of a run with two SDK segments sends one stop request for each of them, the host cancels the World run in work, and status shows the dropped run as stopped only after each stop is confirmed", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
writeFileSync("hold", "");
let entered = 0;
const wrap = (product) => ({ ...recording(product), stop: async (intent) => {
  entered += 1;
  while (intent.kind === "continue-run" && !existsSync("allow-stop")) await delay(10);
  const outcome = await product.stop(intent);
  calls.push("stop " + intent.kind + " " + outcome.kind);
  return outcome;
} });
const service = await hosted({ wrap });
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "waiting_gate");
await answered(runId);
await until(async () => (await tagged()).some((run) => run.operation.includes("continue-run") && run.status === "running"));
const shown = async () => { const run = (await asked("status", { runId })).run; return [run.state, run.reason.code]; };
await asked("run-command", { command: "drop", runId, expectedRevision: (await asked("status", { runId })).run.revision, commandId: "c-drop" });
await until(() => entered > 0);
await delay(300);
const before = await shown();
writeFileSync("allow-stop", "");
await until(async () => (await shown())[1] === "run-cancelled");
print({ before, after: await shown(), world: (await segments()).map((segment) => [segment.kind, segment.status]), stops: calls.filter((call) => call.startsWith("stop")).sort() });
rmSync("hold");
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        before: ["cancelled", "delivery-in-flight"],
        after: ["cancelled", "run-cancelled"],
        world: [
          ["start-run", "completed"],
          ["continue-run", "cancelled"],
        ],
        stops: ["stop continue-run stopped", "stop start-run stopped"],
      },
    ]);
  }));

await test("CLV-057 with the host bound 1, a second run starts while the first run waits for a decision between two SDK segments", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${waiting}
const second = await submitted("c-2");
await until(async () => (await stateOf(second)) === "waiting_gate");
await until(async () => (await tagged()).every((run) => run.status === "completed"));
print({ bound: process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY, states: [await stateOf(runId), await stateOf(second)], world: (await segments()).map((segment) => [segment.kind, segment.status]) });
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        bound: "1",
        states: ["waiting_gate", "waiting_gate"],
        world: [
          ["start-run", "completed"],
          ["start-run", "completed"],
        ],
      },
    ]);
  }));
