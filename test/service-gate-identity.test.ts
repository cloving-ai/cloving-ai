import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  later,
  noon,
  startedRun,
  waitingGate,
  withHarness,
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
