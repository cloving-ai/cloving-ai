import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import { serviceLimits } from "../src/service/service.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  startedRun,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const subject = digestOf("approval of c-1?");

await test("CLV-008 a decision with the command ID of a different kind of command is a conflict", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const reused = await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject,
      commandId: "c-1",
    });
    assert.deepEqual(
      [
        field(reused, "kind"),
        field(reused, "code"),
        field(reused, "commandId"),
      ],
      ["error", "conflicting-command", "c-1"],
    );
    const listed = await call(harness, {
      operation: "questions",
      parameters: {},
    });
    assert.equal(JSON.stringify(listed).includes(waiting.decisionId), true);
    await service.close();
  }));

await test("CLV-008 a stale decision gives the current revision of its gate", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const stale = await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject,
      expectedRevision: 2,
    });
    assert.deepEqual(
      [field(stale, "code"), field(stale, "currentRevision")],
      ["stale-revision", 1],
    );
    await service.close();
  }));

await test("CLV-008 a decision reports a held continuation while the run waits for a second decision", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const second = "second approval?";
    await service.worker.openGate({
      runId: waiting.runId,
      commandId: "c-1-open-2",
      expectedRevision: 3,
      gateId: "design-2",
      kind: "approval",
      prompt: second,
      subject: digestOf(second),
    });
    await service.worker.registerWait({
      runId: waiting.runId,
      commandId: "c-1-wait-2",
      gateId: "design-2",
    });
    const first = await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject,
    });
    assert.deepEqual(
      [field(first, "continuation"), field(first, "run")],
      ["held", { state: "waiting_gate", revision: 5 }],
    );
    assert.equal(harness.sent.length, 1);
    const last = await decide(harness, {
      command: "deny",
      reference: `${waiting.runId}/design-2`,
      subjectDigest: digestOf(second),
      commandId: "c-decide-2",
    });
    assert.deepEqual(
      [field(last, "continuation"), field(last, "run")],
      ["admitted", { state: "running", revision: 6 }],
    );
    await service.close();
  }));

await test("CLV-008 an answer and a gate prompt above the declared text limit are rejected and store nothing", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      limits: { ...serviceLimits, textBytes: 64 },
    });
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const long = "é".repeat(33);
    const refused = await service.worker.openGate({
      runId,
      commandId: "c-1-open-long",
      expectedRevision: 2,
      gateId: "design-0",
      kind: "question",
      prompt: long,
      subject: digestOf(long),
    });
    assert.deepEqual(
      [field(refused, "kind"), field(refused, "reason")],
      ["rejected", "input-too-large"],
    );
    const prompt = "é".repeat(32);
    await service.worker.openGate({
      runId,
      commandId: "c-1-open",
      expectedRevision: 2,
      gateId: "design-1",
      kind: "question",
      prompt,
      subject: digestOf(prompt),
    });
    const answer = {
      command: "answer",
      reference: `${runId}/design-1`,
      subjectDigest: digestOf(prompt),
    };
    const large = await decide(harness, { ...answer, text: long });
    assert.deepEqual(
      [field(large, "kind"), field(large, "code"), field(large, "commandId")],
      ["error", "input-too-large", "c-decide"],
    );
    const accepted = await decide(harness, { ...answer, text: prompt });
    assert.equal(field(accepted, "kind"), "decision-recorded");
    await service.close();
  }));

await test("CLV-008 the worker port rejects a gate subject that is not a digest", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const refused = await service.worker.openGate({
      runId,
      commandId: "c-1-open",
      expectedRevision: 2,
      gateId: "design-1",
      kind: "approval",
      prompt: "Deploy the plan?",
      subject: "plan-v1",
    });
    assert.deepEqual(
      [field(refused, "kind"), field(refused, "reason")],
      ["rejected", "invalid-command"],
    );
    const raw = {
      kind: "open-gate",
      runId,
      commandId: "c-1-open-raw",
      expectedRevision: 2,
      gateId: "design-2",
      gateKind: "approval",
      prompt: digestOf("Deploy the plan?"),
    };
    const direct = await service.worker.submit({ ...raw, subject: "plan-v1" }, [
      "Deploy the plan?",
    ]);
    assert.deepEqual(
      [field(direct, "kind"), field(direct, "reason")],
      ["rejected", "invalid-command"],
    );
    const long = "x".repeat(70_000);
    const large = await service.worker.submit(
      { ...raw, subject: digestOf(long), prompt: digestOf(long) },
      [long],
    );
    assert.deepEqual(
      [field(large, "kind"), field(large, "reason")],
      ["rejected", "input-too-large"],
    );
    const listed = await call(harness, {
      operation: "questions",
      parameters: {},
    });
    assert.deepEqual(field(listed, "decisions"), []);
    await service.close();
  }));

function runCommand(
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  return call(harness, { operation: "run-command", parameters });
}

function gatedContinuations(
  sent: DeliveryIntent[],
  gate: { reachable: boolean },
): Delivery {
  return {
    reconcile: () => Promise.resolve({ kind: "absent" }),
    deliver: (intent) => {
      if (intent.kind === "continue-run" && !gate.reachable)
        return Promise.reject(new Error("destination unreachable"));
      sent.push(intent);
      return Promise.resolve({ receipt: `wrun-${String(sent.length)}` });
    },
  };
}

await test("CLV-008 a repeated decision reports a held continuation while the run is paused, and an admitted continuation after its delivery", () =>
  withHarness(async (harness) => {
    const gate = { reachable: false };
    const service = await harness.start({
      delivery: gatedContinuations(harness.sent, gate),
    });
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const { runId } = waiting;
    const approve = {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject,
    };
    const continuation = async (): Promise<unknown> =>
      field(await decide(harness, approve), "continuation");
    assert.equal(await continuation(), "admitted");
    await runCommand(harness, {
      command: "pause",
      runId,
      expectedRevision: 4,
      commandId: "c-pause",
    });
    assert.equal(await continuation(), "held");
    gate.reachable = true;
    await runCommand(harness, {
      command: "resume",
      runId,
      expectedRevision: 5,
      commandId: "c-resume",
    });
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    assert.equal(await continuation(), "admitted");
    await runCommand(harness, {
      command: "pause",
      runId,
      expectedRevision: 6,
      commandId: "c-pause-2",
    });
    assert.equal(await continuation(), "admitted");
    await service.close();
  }));

const invalid = { kind: "rejected", reason: "invalid-command" };

function mixed(values: readonly unknown[]): string[] {
  const documents: string[] = [];
  values.forEach((value, index) => Reflect.set(documents, index, value));
  return documents;
}

await test("CLV-008 a worker document that is not a text is rejected as an invalid command, and each run stays in use", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const first = await startedRun(harness, { service, commandId: "c-1" });
    const second = await startedRun(harness, { service, commandId: "c-2" });
    const prompt = "Which parser?";
    const opening = {
      runId: first,
      commandId: "c-1-open",
      expectedRevision: 2,
      gateId: "design-1",
      kind: "question" as const,
      prompt,
      subject: digestOf(prompt),
    };
    for (const body of [Buffer.from(prompt), new Uint8Array([1, 2, 3]), 5]) {
      const binary = { ...opening };
      Reflect.set(binary, "prompt", body);
      assert.deepEqual(await service.worker.openGate(binary), invalid);
    }
    const { kind, ...rest } = opening;
    const direct = await service.worker.submit(
      { ...rest, kind: "open-gate", gateKind: kind, prompt: digestOf(prompt) },
      mixed([Buffer.from(prompt)]),
    );
    assert.deepEqual(direct, invalid);
    const report = await service.worker.observe({
      runId: second,
      commandId: "c-2-report",
      condition: "working",
      reason: "progress",
    });
    assert.equal(field(report, "kind"), "accepted");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status, "kind"), "run-list");
    const opened = await service.worker.openGate(opening);
    assert.equal(field(opened, "kind"), "accepted");
    await service.close();
  }));

await test("CLV-008 the gateway checks the JSON form of a worker command, so a command with a different JSON form gets no protected effect", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const report = {
      kind: "report-observation",
      runId,
      commandId: "c-1-report",
      condition: "working",
      reason: "progress",
    };
    const cancelling = { ...report };
    Object.setPrototypeOf(cancelling, {
      toJSON: () => ({
        kind: "cancel-run",
        runId,
        commandId: "c-1-cancel",
        expectedRevision: 2,
      }),
    });
    assert.deepEqual(await service.worker.submit(cancelling), {
      kind: "rejected",
      reason: "permission-denied",
      detail: "worker cannot send cancel-run",
    });
    let nested: unknown = "progress";
    for (let level = 0; level < 150; level += 1) nested = [nested];
    const deep = { ...report };
    Object.setPrototypeOf(deep, {
      toJSON: () => ({ ...report, reason: nested }),
    });
    assert.deepEqual(await service.worker.submit(deep), invalid);
    const cyclic: Record<string, unknown> = { ...report };
    cyclic["self"] = cyclic;
    assert.deepEqual(await service.worker.submit(cyclic), {
      ...invalid,
      detail: "unserializable-command",
    });
    assert.equal(
      field(await service.worker.submit(report), "kind"),
      "accepted",
    );
    const status = await call(harness, {
      operation: "status",
      parameters: { runId },
    });
    assert.deepEqual(
      [
        field(field(status, "run"), "state"),
        field(field(status, "run"), "revision"),
      ],
      ["running", 2],
    );
    await service.close();
  }));
