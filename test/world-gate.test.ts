import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  productRoot,
  servicePrelude,
  withConsumer,
} from "./world-host-fixture.ts";

const workflows = `
import { existsSync } from "node:fs";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";

export async function gateKind() {
  "use step";
  return existsSync("question-gate") ? "question" : "approval";
}

export async function develop(input: { cycleId: string; expiresAt?: string }) {
  "use workflow";
  const cycleId = input.cycleId;
  const decision = await waitForDecision({ gateId: "review-1", kind: await gateKind(), prompt: "Approve the change of " + cycleId + "?", ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) });
  return { kind: "handoff_requested", cycleId, promotionId: "review-1:" + decision.decision + ":" + String(decision.answer) };
}
`;

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function oneSegment(promotionId: string): unknown {
  return [
    {
      kind: "start-run",
      status: "completed",
      output: { kind: "handoff_requested", cycleId: "cycle-1", promotionId },
    },
  ];
}

const decisions = `
const decide = async (runId, command, text) => {
  const [pending] = (await asked("questions", { runId })).decisions;
  const reply = await asked("decision", { command, reference: pending.decisionId, subjectDigest: pending.subjectDigest, expectedRevision: pending.revision, generation: pending.generation, commandId: "c-" + command, ...(text === undefined ? {} : { text }) });
  return { pending: [pending.type, pending.gateId, pending.prompt, pending.allowed], reply: reply.kind };
};
const waits = async () => Object.values((await ports.state()).gates).map((gate) => [gate.gateId, gate.wait]);
const gateEvents = async (runId) => (await eventTypes(runId)).filter((type) => type.startsWith("gate."));
const ended = async (runId) => {
  await until(async () => (await stateOf(runId)) === "completed");
  await until(async () => (await tagged()).every((run) => run.status === "completed"));
};
`;

const waiting = `
const service = await hosted();
const runId = await submitted("c-1");
await until(async () => (await stateOf(runId)) === "waiting_gate");
await until(async () => (await waits()).every(([, wait]) => wait === "hook"));
`;

const pendingApproval = [
  "approval",
  "review-1",
  "Approve the change of cycle-1?",
  ["approve", "deny"],
];

const deadlineRegistration = `
const registration = fakeRegistration([]);
const registrations = [{ ...registration, resolver: {
  ...registration.resolver,
  resolve: async () => ({ kind: "resolved", input: { cycleId: "cycle-1", expiresAt: "2099-10-20T10:00:00.000Z" } }),
} }];
`;

await test("CLV-117 a compiled question preserves the supplied deadline after a crash before wait registration", () =>
  withConsumer(workflows, async (consumer) => {
    await consumer.runUntil(
      "halted-before-wait",
      `${servicePrelude}${deadlineRegistration}
writeFileSync("question-gate", "");
writeFileSync("halt-before-wait", "");
const service = await hosted({ registrations });
await submitted("c-deadline");
`,
    );
    const result = await consumer.run(`${servicePrelude}${decisions}
rmSync("halt-before-wait");
const service = await hosted();
const runId = (await tagged())[0].run;
await until(async () => (await waits()).every(([, wait]) => wait === "hook"));
const [pending] = (await asked("questions", { runId })).decisions;
const decision = await decide(runId, "answer", "earlier");
await ended(runId);
print({ expiresAt: pending.expiresAt, decision: decision.reply, segments: await segments(), events: await gateEvents(runId), budget: (await asked("status", { runId })).run.budget });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [
      {
        expiresAt: "2099-10-20T10:00:00.000Z",
        decision: "decision-recorded",
        segments: oneSegment("review-1:answered:earlier"),
        events: ["gate.opened", "gate.decided"],
        budget: null,
      },
    ]);
  }));

await test("CLV-010 a compiled workflow opens an approval gate through the product host, and after the approval the same call completes the run", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${decisions}${waiting}
const decision = await decide(runId, "approve");
await ended(runId);
print({ decision, segments: await segments(), events: await gateEvents(runId) });
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        decision: { pending: pendingApproval, reply: "decision-recorded" },
        segments: oneSegment("review-1:approved:null"),
        events: ["gate.opened", "gate.decided"],
      },
    ]);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-010 after a process stop between the gate opening and the wait registration, the next host registers the wait with no second gate opening, and the run continues after the decision", () =>
  withConsumer(workflows, async (consumer) => {
    await consumer.runUntil(
      "halted-before-wait",
      `${servicePrelude}
writeFileSync("halt-before-wait", "");
const service = await hosted();
await submitted("c-1");
`,
    );
    const result = await consumer.run(`${servicePrelude}${decisions}
rmSync("halt-before-wait");
const service = await hosted();
const runId = (await tagged())[0].run;
const before = await waits();
await until(async () => (await waits()).every(([, wait]) => wait === "hook"));
const decision = await decide(runId, "approve");
await ended(runId);
print({ before, decision, segments: await segments(), events: await gateEvents(runId) });
await service.close();
`);
    assert.deepEqual(result.lines, [
      {
        before: [["review-1", "hook"]],
        decision: { pending: pendingApproval, reply: "decision-recorded" },
        segments: oneSegment("review-1:approved:null"),
        events: ["gate.opened", "gate.decided"],
      },
    ]);
  }));

await test("CLV-010 a compiled workflow opens a question gate, and the same call gets the answer text of the operator", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}${decisions}
writeFileSync("question-gate", "");${waiting}
const decision = await decide(runId, "answer", "Use the table parser.");
await ended(runId);
print({ decision, segments: await segments() });
await service.close();
`);
    const [line] = result.lines;
    assert.deepEqual(field(line, "decision"), {
      pending: [
        "question",
        "review-1",
        "Approve the change of cycle-1?",
        ["answer"],
      ],
      reply: "decision-recorded",
    });
    assert.deepEqual(
      field(line, "segments"),
      oneSegment("review-1:answered:Use the table parser."),
    );
  }));

await test("CLV-010 the gate step module has an explicit package export, the public entry exports the same function, and the compiled step has a versioned identity", () =>
  withConsumer(workflows, async (consumer) => {
    const manifest: unknown = JSON.parse(
      await readFile(join(productRoot, "package.json"), "utf8"),
    );
    assert.deepEqual(
      field(field(manifest, "exports"), "./workflows/steps/wait-for-decision"),
      {
        types: "./dist/src/steps/wait-for-decision.d.ts",
        import: "./dist/src/steps/wait-for-decision.js",
      },
    );
    assert.match(
      await readFile(join(productRoot, "src/workflows.ts"), "utf8"),
      /export \{ waitForDecision \} from "\.\/steps\/wait-for-decision\.ts";/,
    );
    const compiled = await readFile(
      join(consumer.directory, "artifacts/manifest.json"),
      "utf8",
    );
    assert.equal(
      compiled.includes(
        `step//cloving/workflows/steps/open-decision-wait@${String(field(manifest, "version"))}//openDecisionWait`,
      ),
      true,
      compiled.slice(0, 600),
    );
  }));
