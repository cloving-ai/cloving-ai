import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  text,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { changedManifest } from "./service-views.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";

function unreachableStarts(): Delivery {
  return {
    reconcile: () => Promise.reject(new Error("destination unreachable")),
    deliver: () => Promise.reject(new Error("destination unreachable")),
  };
}

async function shown(
  harness: Parameters<typeof call>[0],
  runId: string,
): Promise<readonly unknown[]> {
  const status = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  const run = field(status, "run");
  return [
    field(run, "workflowId"),
    field(run, "state"),
    field(field(run, "reason"), "code"),
    field(run, "nextAction"),
  ];
}

async function queuedRun(harness: Harness): Promise<string> {
  const first = await harness.start({ delivery: unreachableStarts() });
  const admitted = await call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "prompt",
      submission: { prompt: "the task" },
      commandId: "c-run",
    },
  });
  const runId = text(admitted, "runId");
  await eventually(async () =>
    (await shown(harness, runId))[2] === "delivery-outcome-unknown"
      ? true
      : undefined,
  );
  await first.close();
  return runId;
}

await test("CLV-049 a start in the queue is not sent when the installed workflow differs from the stored pin, and status gives the workflow ID of the stored request", () =>
  withHarness(async (harness) => {
    const runId = await queuedRun(harness);
    const sent: DeliveryIntent[] = harness.sent;
    const changed = await harness.start({
      workflows: [{ ...harness.registration, manifest: changedManifest }],
    });
    await eventually(async () =>
      (await shown(harness, runId))[2] === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    await delay(200);
    assert.equal(sent.length, 0);
    assert.deepEqual(await shown(harness, runId), [
      "develop",
      "queued",
      "pinned-workflow-unavailable",
      "restore-pinned-workflow",
    ]);
    await changed.close();
    const restored = await harness.start();
    await eventually(() => (sent.length === 1 ? true : undefined));
    assert.deepEqual(
      sent.map((intent) => intent.kind),
      ["start-run"],
    );
    assert.equal((await shown(harness, runId))[0], "develop");
    await restored.close();
  }));

await test("CLV-153 a waiting run keeps its supplied retained pin after restart while new submissions use the current version", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const waiting = await waitingGate(harness, {
      service: first,
      commandId: "original",
      kind: "question",
    });
    await first.close();
    const current = { ...harness.registration, manifest: changedManifest };
    const restarted = await harness.start({
      workflows: [current],
      retainedWorkflows: [harness.registration],
    });
    const answer = await decide(harness, {
      command: "answer",
      reference: waiting.decisionId,
      subjectDigest: digestOf("question of original?"),
      text: "Continue on the original version.",
    });
    assert.equal(answer["kind"], "decision-recorded", JSON.stringify(answer));
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    const admitted = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "Use the edited version." },
        commandId: "edited",
      },
    });
    assert.equal(admitted["kind"], "run-admitted");
    await eventually(() => (harness.sent.length === 3 ? true : undefined));
    assert.deepEqual(
      harness.sent.map((intent) => [intent.kind, intent.workflow]),
      [
        ["start-run", workflowPin(harness.registration.manifest)],
        ["continue-run", workflowPin(harness.registration.manifest)],
        ["start-run", workflowPin(changedManifest)],
      ],
    );
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["workflows"], ["develop"]);
    await restarted.close();
  }));

await test("CLV-153 a retained version releases an old queued start after removal without admitting new submissions", () =>
  withHarness(async (harness) => {
    const runId = await queuedRun(harness);
    const restarted = await harness.start({
      workflows: [],
      retainedWorkflows: [harness.registration],
    });
    await eventually(() => (harness.sent.length === 1 ? true : undefined));
    assert.equal(harness.sent[0]?.runId, runId);
    assert.equal(
      harness.sent[0].workflow,
      workflowPin(harness.registration.manifest),
    );
    const refused = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "another task" },
        commandId: "removed",
      },
    });
    assert.equal(refused["code"], "unknown-workflow");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["workflows"], []);
    await restarted.close();
  }));

await test("CLV-153 an unavailable retained version cannot release an old queued start or substitute the current version", () =>
  withHarness(async (harness) => {
    const runId = await queuedRun(harness);
    const restarted = await harness.start({
      workflows: [{ ...harness.registration, manifest: changedManifest }],
      retainedWorkflows: [
        { ...harness.registration, availability: "unavailable" },
      ],
    });
    await delay(200);
    assert.equal(harness.sent.length, 0);
    await eventually(async () =>
      (await shown(harness, runId))[2] === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    assert.equal(harness.sent.length, 0);
    await restarted.close();
  }));
