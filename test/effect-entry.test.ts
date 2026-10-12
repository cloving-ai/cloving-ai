import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectReport,
  effectRequest,
  fakeDestination,
  later,
  noon,
  runningRun,
  sender,
  type Destination,
  type Request,
  type Send,
} from "./effect-fixture.ts";
import type { Authority } from "../src/broker/actor/authority.ts";

after(removeTemporaryDirectories);

interface Opened {
  readonly authority: Authority;
  readonly destination: Destination;
  readonly directory: string;
}

async function opened(destination: Destination): Promise<Opened> {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  return { authority, destination, directory };
}

function settledAt(
  authority: Authority,
  expected: { readonly operationId: string; readonly status: string },
): Promise<void> {
  return deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(expected.operationId))?.status ===
      expected.status,
  );
}

async function regranted(scene: {
  readonly authority: Authority;
  readonly send: Send;
  readonly operationId: string;
}): Promise<void> {
  const { authority, send, operationId } = scene;
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-1" };
  await send({ ...pause, expectedRevision: 2 });
  await settledAt(authority, { operationId, status: "waiting" });
  await send({
    ...pause,
    kind: "resume-run",
    commandId: "c-resume",
    expectedRevision: 3,
  });
  await settledAt(authority, { operationId, status: "running" });
}

function reportOf(
  request: Request,
  result: { readonly generation: number; readonly text: string },
): ReturnType<typeof effectReport> {
  const generation = String(result.generation);
  return effectReport(request, {
    commandId: `c-report-${generation}`,
    leaseGeneration: result.generation,
    worker: `worker-${generation}`,
    result: result.text,
  });
}

await test("CLV-049 the authority rejects a result from a retired lease generation, changes no run state and keeps the evidence of the result", async () => {
  const { authority, destination, directory } = await opened(fakeDestination());
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  const admitted = await send(request.command, request.documents);
  assert.deepEqual(
    [admitted.kind, Reflect.get(admitted, "disposition")],
    ["accepted", "admitted"],
  );
  await regranted({ authority, send, operationId });
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.leaseGeneration, operation?.worker],
    [2, "worker-2"],
  );
  const run = (await authority.state()).runs["run-1"];
  const late = reportOf(request, { generation: 1, text: "the late result" });
  const rejected = await send(late.command, late.documents);
  assert.deepEqual(
    [rejected.kind, Reflect.get(rejected, "disposition")],
    ["accepted", "rejected"],
  );
  const evidence = {
    runId: "run-1",
    operationId,
    disposition: "rejected",
    reason: "retired-lease-generation",
  };
  const sequence = Number(Reflect.get(rejected, "sequence"));
  assert.deepEqual(await authority.effects.disposition(sequence), evidence);
  assert.deepEqual((await authority.state()).runs["run-1"], run);
  assert.deepEqual(await authority.effects.operation(operationId), operation);
  const current = reportOf(request, { generation: 2, text: "the result" });
  const applied = await send(current.command, current.documents);
  assert.equal(Reflect.get(applied, "disposition"), "applied");
  await authority.close();
  const reopened = await openedAuthority(directory, { clock: () => noon });
  assert.deepEqual(await reopened.effects.disposition(sequence), evidence);
  const settled = await reopened.effects.operation(operationId);
  assert.deepEqual(
    [settled?.status, settled?.result],
    ["completed", digestOf("the result")],
  );
  assert.equal(
    await reopened.queries.document(digestOf("the late result")),
    "the late result",
  );
  assert.deepEqual(destination.effects, [operationId]);
  await reopened.close();
});

await test("CLV-049 after a lost reply of a protected effect, the recovery reconciles the same operation, and the fake destination has one logical effect", async () => {
  const { authority, destination, directory } = await opened(
    fakeDestination({ lostReplies: 1 }),
  );
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  const admitted = await send(request.command, request.documents);
  assert.equal(Reflect.get(admitted, "disposition"), "admitted");
  await settledAt(authority, { operationId, status: "running" });
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.attempts, operation?.receipt, operation?.leaseGeneration],
    [1, "receipt-1", 1],
  );
  assert.deepEqual(destination.calls, [
    `reconcile ${operationId}`,
    `deliver ${operationId}`,
    `reconcile ${operationId}`,
  ]);
  assert.deepEqual(destination.effects, [operationId]);
  await authority.close();
  const reopened = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  await deliverUntil(
    reopened,
    async () => (await reopened.eligibleIntents()).length === 0,
  );
  assert.deepEqual(destination.effects, [operationId]);
  assert.equal(
    destination.calls.filter((call) => call.startsWith("deliver")).length,
    1,
  );
  await reopened.close();
});

await test("CLV-049 a drop after the intent commit and before the send prevents the send of the protected effect", async () => {
  const { authority, destination } = await opened(fakeDestination());
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  const admitted = await send(request.command, request.documents);
  assert.equal(Reflect.get(admitted, "disposition"), "admitted");
  const pending = await authority.effects.operation(operationId);
  assert.equal(pending?.status, "dispatch-pending");
  const dropped = await send({
    kind: "cancel-run",
    commandId: "c-drop",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(dropped.kind, "accepted");
  await settledAt(authority, { operationId, status: "cancelled" });
  assert.deepEqual(
    destination.calls.filter((call) => call.startsWith("deliver")),
    [],
  );
  assert.deepEqual(destination.effects, []);
  assert.equal((await authority.state()).runs["run-1"]?.status, "cancelled");
  await authority.close();
});

await test("CLV-049 the adapter gets the purpose, the lease generation and the effect input of a protected effect with its dispatch attempt", async () => {
  const { authority, destination } = await opened(fakeDestination());
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  await send(request.command, request.documents);
  await settledAt(authority, { operationId, status: "running" });
  assert.deepEqual(destination.intents, [
    {
      kind: "protected-effect",
      runId: "run-1",
      operationId,
      workflow: (await authority.state()).runs["run-1"]?.workflow,
      inputDigest: request.inputDigest,
      purpose: "dispatch",
      leaseGeneration: 1,
      capability: "fake-harness",
      method: "run-turn",
      target: "workspace/main",
      payload: digestOf("build the package"),
    },
  ]);
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.receipt, operation?.worker, operation?.attempts],
    ["receipt-1", "worker-1", 0],
  );
  assert.deepEqual(await authority.eligibleIntents(), []);
  await authority.close();
});

await test("CLV-049 a dispatch attempt whose reconciliation finds the effect at the destination records the acceptance and sends nothing", async () => {
  const destination = fakeDestination();
  const { authority } = await opened(destination);
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  destination.effects.push(operationId);
  await send(request.command, request.documents);
  await settledAt(authority, { operationId, status: "running" });
  assert.deepEqual(destination.calls, [`reconcile ${operationId}`]);
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.receipt, operation?.worker],
    ["receipt-1", "worker-1"],
  );
  await authority.close();
});

await test("CLV-049 a dispatch attempt at or after the expiry of its lease on the handler clock is withheld, and the operation gets a new lease generation before its send", async () => {
  const directory = await temporaryDirectory();
  const destination = fakeDestination();
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => later,
    timing: fastTiming,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  await send(request.command, request.documents);
  await settledAt(authority, { operationId, status: "running" });
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.leaseGeneration, operation?.worker],
    [2, "worker-2"],
  );
  assert.deepEqual(destination.calls, [
    `reconcile ${operationId}`,
    `reconcile ${operationId}`,
    `deliver ${operationId}`,
  ]);
  assert.deepEqual(
    (await authority.events())
      .slice(4)
      .map((event) => [
        event.type,
        event.recordedAt,
        event.payload["outcome"] ?? event.payload["expiresAt"],
      ]),
    [
      ["operation.reconciled", later, "not-started"],
      ["lease.granted", later, "2026-10-10T12:20:00.000Z"],
      ["operation.reconciled", later, "accepted"],
    ],
  );
  await authority.close();
  await (await openedAuthority(directory)).close();
});
