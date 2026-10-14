import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  items,
  later,
  noon,
  parsed,
  startedRun,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const prompt = "Which color is correct?";

await test("CLV-008 the worker cannot open a question identity again, and the first answer reaches the workflow one time", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const opening = {
      runId,
      gateId: "design-1",
      kind: "question",
      prompt,
      subject: digestOf(prompt),
    } as const;
    await service.worker.openGate({
      ...opening,
      commandId: "c-1-open",
      expectedRevision: 2,
    });
    const answered = await decide(harness, {
      command: "answer",
      reference: `${runId}/design-1`,
      text: "blue",
      subjectDigest: digestOf(prompt),
    });
    assert.equal(field(answered, "continuation"), "held");
    const again = await service.worker.openGate({
      ...opening,
      commandId: "c-1-open-2",
      expectedRevision: 4,
    });
    assert.deepEqual(
      [field(again, "kind"), field(again, "reason")],
      ["rejected", "existing-gate"],
    );
    await service.worker.registerWait({
      runId,
      commandId: "c-1-wait",
      gateId: "design-1",
    });
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    await delay(200);
    assert.deepEqual(
      harness.sent.slice(1).map((intent) => [intent.decision, intent.answer]),
      [["answered", digestOf("blue")]],
    );
    const listed = await call(harness, {
      operation: "questions",
      parameters: {},
    });
    assert.deepEqual(field(listed, "decisions"), []);
    await service.close();
    const restarted = await harness.start();
    const status = await call(harness, {
      operation: "status",
      parameters: { runId },
    });
    assert.equal(field(field(status, "run"), "condition"), "working");
    await restarted.close();
  }));

await test("CLV-008 an expired approval identity is not opened again, and the run does not wait for a second expiry", () =>
  withHarness(async (harness) => {
    let now = noon;
    const service = await harness.start({ clock: () => now });
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
      expiresAt: later,
    });
    now = later;
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    const again = await service.worker.openGate({
      runId: waiting.runId,
      commandId: "c-1-open-2",
      expectedRevision: 4,
      gateId: "design-1",
      kind: "approval",
      prompt,
      subject: digestOf(prompt),
      expiresAt: "2026-10-10T14:00:00.000Z",
    });
    assert.deepEqual(
      [field(again, "kind"), field(again, "reason")],
      ["rejected", "existing-gate"],
    );
    const status = await call(harness, {
      operation: "status",
      parameters: { runId: waiting.runId },
    });
    assert.deepEqual(
      [
        field(field(status, "run"), "state"),
        field(field(status, "run"), "pendingDecisions"),
      ],
      ["running", []],
    );
    await service.close();
  }));

const feedback = "Add a test for an empty list.";
const approvalPrompt = "approval of c-1?";
const binding = [
  "--expected-revision",
  "1",
  "--generation",
  "1",
  "--subject-digest",
  digestOf(approvalPrompt),
];

async function deniedRun(
  harness: Harness,
): Promise<Readonly<Record<string, string>>> {
  const service = await harness.start();
  const { runId, decisionId } = await waitingGate(harness, {
    service,
    commandId: "c-1",
    kind: "approval",
  });
  const large = await harness.cli([
    "deny",
    decisionId,
    "--text",
    "é".repeat(4_001),
    ...binding,
    "--json",
  ]);
  assert.equal(field(parsed(large), "code"), "input-too-large");
  assert.equal(
    field(
      await decide(harness, {
        command: "approve",
        reference: decisionId,
        subjectDigest: digestOf(approvalPrompt),
        text: feedback,
      }),
      "code",
    ),
    "invalid-request",
  );
  const denied = await harness.cli([
    "deny",
    decisionId,
    "--text",
    feedback,
    ...binding,
    "--json",
  ]);
  assert.equal(field(parsed(denied), "decision"), "denied");
  const second = "approval of round 2?";
  await service.worker.openGate({
    runId,
    commandId: "c-1-open-2",
    expectedRevision: 4,
    gateId: "design-2",
    kind: "approval",
    prompt: second,
    subject: digestOf(second),
  });
  await service.worker.registerWait({
    runId,
    commandId: "c-1-wait-2",
    gateId: "design-2",
  });
  await service.close();
  return { runId, decisionId };
}

await test("CLV-062 cloving deny --text records the feedback with the denial, and status and questions show it, also after a restart", () =>
  withHarness(async (harness) => {
    const { runId = "", decisionId = "" } = await deniedRun(harness);
    await harness.start();
    const earlier = [{ decisionId, text: feedback }];
    const status = parsed(await harness.cli(["status", runId, "--json"]));
    assert.deepEqual(field(field(status, "run"), "feedback"), earlier);
    assert.match(
      (await harness.cli(["status", runId])).stdout,
      new RegExp(`\\nFeedback of ${decisionId}: ${feedback}\\n`),
    );
    const questions = parsed(await harness.cli(["questions", "--json"]));
    const [pending] = items(field(questions, "decisions"));
    assert.equal(field(pending, "decisionId"), `${runId}/design-2`);
    assert.deepEqual(field(pending, "feedback"), earlier);
    assert.match(
      (await harness.cli(["questions"])).stdout,
      new RegExp(`\\n  Feedback of ${decisionId}: ${feedback}\\n`),
    );
  }));
