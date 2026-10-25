import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  decide,
  digestOf,
  field,
  fields,
  items,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { command } from "./service-views.ts";

const subject = (kind: string, commandId: string): string =>
  digestOf(`${kind} of ${commandId}?`);

async function decidedPayload(
  harness: Harness,
): Promise<Readonly<Record<string, unknown>>> {
  const reply = await call(harness, {
    operation: "events",
    parameters: { after: 0, limit: 100 },
  });
  const decided = items(field(reply, "events"))
    .map(fields)
    .filter((event) => event["type"] === "gate.decided");
  assert.equal(decided.length, 1);
  return fields(decided[0]?.["payload"]);
}

await test("CLV-186 an approve with a device actor records the actor in the reply and the event", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const result = await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject("approval", "c-1"),
      commandId: "phone-1",
      actor: "device:pixel8a",
    });
    assert.equal(field(result, "kind"), "decision-recorded");
    assert.equal(field(result, "actor"), "device:pixel8a");
    assert.equal((await decidedPayload(harness))["actor"], "device:pixel8a");
    await service.close();
  }));

await test("CLV-186 the same command ID with another actor conflicts, and the same actor replays the first receipt", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const request = {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject("approval", "c-1"),
      commandId: "phone-1",
      actor: "device:pixel8a",
    };
    const first = await decide(harness, request);
    const other = await decide(harness, { ...request, actor: "device:other" });
    assert.equal(field(other, "code"), "conflicting-command");
    const again = await decide(harness, request);
    assert.equal(field(again, "replayed"), true);
    assert.equal(field(again, "actor"), "device:pixel8a");
    assert.deepEqual(field(again, "receipt"), field(first, "receipt"));
    await service.close();
  }));

await test("CLV-186 a device answer after a terminal answer is not pending, and the event keeps the local operator", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await waitingGate(harness, { service, commandId: "c-1", kind: "question" });
    const terminal = await decide(harness, {
      command: "answer",
      reference: "Q1",
      text: "From the terminal.",
      subjectDigest: subject("question", "c-1"),
    });
    assert.equal(field(terminal, "actor"), null);
    const phone = await decide(harness, {
      command: "answer",
      reference: "Q1",
      text: "From the phone.",
      subjectDigest: subject("question", "c-1"),
      commandId: "phone-2",
      actor: "device:pixel8a",
    });
    assert.equal(field(phone, "code"), "decision-not-pending");
    assert.equal((await decidedPayload(harness))["actor"], undefined);
    await service.close();
  }));

await test("CLV-186 a stale generation with an actor gives stale-generation", () =>
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
      subjectDigest: subject("approval", "c-1"),
      generation: 2,
      commandId: "phone-3",
      actor: "device:pixel8a",
    });
    assert.equal(field(stale, "code"), "stale-generation");
    await service.close();
  }));

await test("CLV-186 malformed actors are refused before the gateway", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    for (const actor of [
      "device:",
      "device:a b",
      "phone:x",
      `device:${"a".repeat(65)}`,
      7,
    ]) {
      const refused = await decide(harness, {
        command: "approve",
        reference: waiting.decisionId,
        subjectDigest: subject("approval", "c-1"),
        commandId: "phone-4",
        actor,
      });
      assert.equal(field(refused, "code"), "invalid-request", String(actor));
    }
    const listed = await call(harness, {
      operation: "questions",
      parameters: {},
    });
    assert.equal(items(field(listed, "decisions")).length, 1);
    await service.close();
  }));

await test("CLV-186 status shows local for a terminal decision and the device actor for a device decision", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const terminal = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await decide(harness, {
      command: "approve",
      reference: terminal.decisionId,
      subjectDigest: subject("approval", "c-1"),
      commandId: "terminal-1",
    });
    const phone = await waitingGate(harness, {
      service,
      commandId: "c-2",
      kind: "approval",
    });
    await decide(harness, {
      command: "approve",
      reference: phone.decisionId,
      subjectDigest: subject("approval", "c-2"),
      commandId: "phone-5",
      actor: "device:pixel8a",
    });
    const shown = await harness.cli(["status", phone.runId, "--json"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(
      field(fields(JSON.parse(shown.stdout))["run"], "decisions"),
      [
        {
          decisionId: phone.decisionId,
          decision: "approved",
          actor: "device:pixel8a",
        },
      ],
    );
    const local = await call(harness, {
      operation: "status",
      parameters: { runId: terminal.runId },
    });
    assert.deepEqual(field(field(local, "run"), "decisions"), [
      { decisionId: terminal.decisionId, decision: "approved", actor: "local" },
    ]);
    const text = await harness.cli(["status", phone.runId]);
    assert.match(
      text.stdout,
      new RegExp(
        `\\nDecision ${phone.decisionId}: approved by device:pixel8a\\n`,
      ),
    );
    await service.close();
  }));

await test("CLV-186 status lists no decision for a gate that closed because its run was dropped", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const dropped = await command(harness, {
      command: "drop",
      runId: waiting.runId,
      expectedRevision: 3,
      commandId: "c-drop",
    });
    assert.equal(field(dropped, "kind"), "run-command");
    const shown = await call(harness, {
      operation: "status",
      parameters: { runId: waiting.runId },
    });
    assert.deepEqual(field(field(shown, "run"), "decisions"), []);
    await service.close();
  }));
