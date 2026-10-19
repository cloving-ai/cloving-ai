import assert from "node:assert/strict";
import { test } from "node:test";
import { stepBridge } from "../src/host/step-bridge-host.ts";
import type { HostPorts } from "../src/service/service.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  items,
  later,
  noon,
  startedRun,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const question = {
  gateId: "analysis-conflict",
  kind: "question",
  prompt: "Which synthetic review order applies: earlier or later?",
  expiresAt: later,
} as const;

async function hosted(harness: Harness, clock: () => string) {
  const captured: HostPorts[] = [];
  const service = await harness.start({
    clock,
    workflows: [{ ...harness.registration, effectLimit: 5 }],
    host: (ports) => {
      captured.push(ports);
      return Promise.resolve({ close: () => Promise.resolve() });
    },
  });
  const [ports] = captured;
  assert.ok(ports);
  return {
    service,
    ports,
    bridge: (runId: string) =>
      stepBridge({
        ...ports,
        call: () => ({
          worldRunId: "wrun-deadline",
          stepId: "step-deadline",
          attempt: 1,
        }),
        run: () => Promise.resolve({ runId }),
        stopped: new AbortController().signal,
      }),
  };
}

async function pending(harness: Harness, runId: string) {
  return items(
    field(
      await call(harness, { operation: "questions", parameters: { runId } }),
      "decisions",
    ),
  );
}

async function gateEvents(harness: Harness, runId: string) {
  return items(
    field(
      await call(harness, {
        operation: "events",
        parameters: { runId, after: 0, limit: 100 },
      }),
      "events",
    ),
  )
    .map((event) => field(event, "type"))
    .filter((type) => String(type).startsWith("gate."));
}

function continuations(harness: Harness) {
  return harness.sent
    .filter((intent) => intent.kind === "continue-run")
    .map((intent) => [
      intent.runId,
      intent.gateId,
      intent.decision,
      intent.answer,
    ]);
}

async function budget(harness: Harness, runId: string) {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  return field(field(status, "run"), "budget");
}

const answer = (runId: string) => ({
  command: "answer",
  reference: `${runId}/${question.gateId}`,
  text: "earlier",
  subjectDigest: digestOf(question.prompt),
});

await test("CLV-117 a bridged question retains its deadline across restart and replay, then expires once without charging an effect", () =>
  withHarness(async (harness) => {
    let now = noon;
    const first = await hosted(harness, () => now);
    const runId = await startedRun(harness, {
      service: first.service,
      commandId: "c-deadline",
    });
    assert.deepEqual(await first.bridge(runId).gate(question), {
      kind: "opened",
      decisionId: question.gateId,
    });
    const [before] = await pending(harness, runId);
    assert.equal(field(before, "expiresAt"), later);
    assert.equal(field(before, "subjectDigest"), digestOf(question.prompt));
    assert.equal(harness.sent.length, 1);
    const unchangedBudget = await budget(harness, runId);
    await first.service.close();
    now = "2026-10-10T12:30:00.000Z";
    const second = await hosted(harness, () => now);
    await second.bridge(runId).gate({
      ...question,
      expiresAt: "2026-10-11T13:00:00.000Z",
    });
    assert.deepEqual(await pending(harness, runId), [before]);
    now = later;
    assert.ok(
      ["decision-expired", "decision-not-pending"].includes(
        String(field(await decide(harness, answer(runId)), "code")),
      ),
    );
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    assert.deepEqual(await pending(harness, runId), []);
    assert.deepEqual(continuations(harness), [
      [runId, question.gateId, "expired", null],
    ]);
    assert.equal(
      field(await decide(harness, answer(runId)), "code"),
      "decision-not-pending",
    );
    await second.bridge(runId).gate(question);
    assert.deepEqual(await pending(harness, runId), []);
    assert.deepEqual(await budget(harness, runId), unchangedBudget);
    assert.deepEqual(await gateEvents(harness, runId), [
      "gate.opened",
      "gate.wait-registered",
      "gate.expired",
    ]);
    await second.service.close();
  }));

await test("CLV-117 an answer before the bridged deadline replays its receipt after restart and never expires or reopens", () =>
  withHarness(async (harness) => {
    let now = noon;
    const first = await hosted(harness, () => now);
    const runId = await startedRun(harness, {
      service: first.service,
      commandId: "c-answer-deadline",
    });
    await first.bridge(runId).gate(question);
    const command = answer(runId);
    const recorded = await decide(harness, command);
    assert.equal(field(recorded, "kind"), "decision-recorded");
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    await first.service.close();
    now = later;
    const second = await hosted(harness, () => now);
    const repeated = await decide(harness, command);
    assert.equal(field(repeated, "replayed"), true);
    assert.deepEqual(field(repeated, "receipt"), field(recorded, "receipt"));
    assert.equal(
      field(await decide(harness, { ...command, text: "later" }), "code"),
      "conflicting-command",
    );
    assert.equal(
      field(await decide(harness, { ...command, commandId: "c-late" }), "code"),
      "decision-not-pending",
    );
    await second.bridge(runId).gate(question);
    assert.deepEqual(await pending(harness, runId), []);
    const gate = Object.values((await second.ports.state()).gates)[0];
    assert.equal(field(gate, "expiresAt"), later);
    assert.deepEqual(continuations(harness), [
      [runId, question.gateId, "answered", digestOf("earlier")],
    ]);
    assert.deepEqual(await gateEvents(harness, runId), [
      "gate.opened",
      "gate.wait-registered",
      "gate.decided",
    ]);
    await second.service.close();
  }));
