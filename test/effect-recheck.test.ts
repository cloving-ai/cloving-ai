import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority, Delivery } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  manifest,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectRequest,
  fakeDestination,
  later,
  noon,
  runningRun,
  sender,
  type Destination,
} from "./effect-fixture.ts";
import { heldReconcile } from "./effect-recheck-fixture.ts";

after(removeTemporaryDirectories);

interface Clock {
  now: string;
}

async function opened(
  directory: string,
  parts: { readonly delivery: Delivery; readonly clock: Clock },
): Promise<Authority> {
  return openedAuthority(directory, {
    delivery: parts.delivery,
    clock: () => parts.clock.now,
    timing: fastTiming,
  });
}

async function outcomes(
  authority: Authority,
  operationId: string,
): Promise<readonly (string | null)[]> {
  return (await authority.operations())
    .filter((record) => record.operationId === operationId)
    .flatMap((record) => record.deliveries.map((item) => item.outcome));
}

const request = effectRequest({ commandId: "c-request", round: 1 });
const { operationId } = request;

for (const scenario of ["available", "lease-expired", "pin-unavailable"])
  await test(`CLV-182 uncertain retry rechecks dispatch authority: ${scenario}`, async () => {
    const clock = { now: noon };
    let sent = false;
    let available = true;
    let retries = 0;
    const authority = await openedAuthority(await temporaryDirectory(), {
      clock: () => clock.now,
      available: (pinned) => (available ? pinned : undefined),
      timing: fastTiming,
      delivery: {
        reconcile: () => Promise.resolve({ kind: sent ? "unknown" : "absent" }),
        deliver: (intent) => {
          if (intent.kind === "protected-effect") {
            sent = true;
            if (scenario === "lease-expired") clock.now = later;
            if (scenario === "pin-unavailable") available = false;
          }
          return Promise.resolve({ kind: "unknown" });
        },
        retry: () => {
          retries += 1;
          return Promise.resolve({
            kind: "completed",
            receipt: "target",
            worker: "handoff",
            result: "target",
          });
        },
      },
    });
    try {
      const send = sender(authority, clock);
      await runningRun(send, { effectLimit: 5 });
      await send(request.command, request.documents);
      const expected = scenario === "available" ? "completed" : "blocked";
      await deliverUntil(
        authority,
        async () =>
          (await authority.effects.operation(operationId))?.status === expected,
      );
      assert.equal(retries, scenario === "available" ? 1 : 0);
      assert.equal(
        (await authority.effects.operation(operationId))?.status,
        expected,
      );
    } finally {
      await authority.close();
    }
  });

await test("CLV-049 a change of ownership between the commit and the send withholds the send", async () => {
  const destination = fakeDestination();
  const held = heldReconcile(destination, "protected-effect");
  const clock = { now: noon };
  const authority = await opened(await temporaryDirectory(), {
    delivery: held.delivery,
    clock,
  });
  const send = sender(authority, clock);
  await runningRun(send, { effectLimit: 5 });
  await send(request.command, request.documents);
  const running = deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  await held.entered;
  clock.now = later;
  held.release();
  await running;
  assert.deepEqual(await outcomes(authority, operationId), [
    "withheld",
    "accepted",
  ]);
  assert.deepEqual(
    held.sent
      .filter((intent) => intent.kind === "protected-effect")
      .map((intent) => intent.leaseGeneration),
    [2],
  );
  assert.deepEqual(destination.effects, [operationId]);
  await authority.close();
});

await test("CLV-049 a cancellation between the authorization read and the adapter call starts no effect", async () => {
  const destination = fakeDestination();
  const held = heldReconcile(destination, "protected-effect");
  const clock = { now: noon };
  const authority = await opened(await temporaryDirectory(), {
    delivery: held.delivery,
    clock,
  });
  const send = sender(authority, clock);
  await runningRun(send, { effectLimit: 5 });
  await send(request.command, request.documents);
  const settled = deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "cancelled",
  );
  await held.entered;
  const dropped = await send({
    kind: "cancel-run",
    commandId: "c-drop",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(dropped.kind, "accepted");
  held.release();
  await settled;
  assert.deepEqual(await outcomes(authority, operationId), ["withheld"]);
  assert.deepEqual(destination.effects, []);
  assert.deepEqual(
    destination.calls.filter((call) => call.startsWith("deliver")),
    [],
  );
  await authority.close();
});

await test("CLV-049 a cancellation between the authorization read and the adapter call of a start in the queue sends no start", async () => {
  const destination = fakeDestination();
  const held = heldReconcile(destination, "start-run");
  const clock = { now: noon };
  const authority = await opened(await temporaryDirectory(), {
    delivery: held.delivery,
    clock,
  });
  const send = sender(authority, clock);
  await send({ ...storedGate[0] });
  const [start] = await authority.eligibleIntents();
  assert.ok(start);
  const closed = deliverUntil(
    authority,
    async () =>
      (await outcomes(authority, start.operationId))[0] === "withheld",
  );
  await held.entered;
  const dropped = await send({
    kind: "cancel-run",
    commandId: "c-drop",
    runId: "run-1",
    expectedRevision: 1,
  });
  assert.equal(dropped.kind, "accepted");
  held.release();
  await closed;
  assert.deepEqual(held.sent, []);
  await authority.close();
});

const changed = {
  ...manifest,
  artifacts: { ...manifest.artifacts, "flow.mjs": "f".repeat(64) },
};

interface Blocked {
  readonly authority: Authority;
  readonly destination: Destination;
}

async function blockedScene(directory: string): Promise<Blocked> {
  const destination = fakeDestination();
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
    available: () => changed,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 2 });
  await send(request.command, request.documents);
  await deliverUntil(
    authority,
    async () => (await outcomes(authority, operationId))[0] === "blocked",
  );
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.status, operation?.leaseGeneration],
    ["dispatch-pending", 1],
  );
  assert.deepEqual(destination.calls, [`reconcile ${operationId}`]);
  return { authority, destination };
}

await test("CLV-049 a dispatch attempt of a protected effect is blocked when the available manifest differs from the stored pin, and the next opening with the pinned manifest sends the operation with its lease", async () => {
  const directory = await temporaryDirectory();
  const first = await blockedScene(directory);
  const { destination } = first;
  await first.authority.close();
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
    available: (pinned) => pinned,
  });
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  assert.deepEqual(await outcomes(authority, operationId), [
    "blocked",
    "accepted",
  ]);
  assert.equal(
    (await authority.effects.operation(operationId))?.leaseGeneration,
    1,
  );
  assert.deepEqual(destination.effects, [operationId]);
  await authority.close();
});

for (const [name, command, reason] of [
  [
    "the turn that drops its run",
    {
      kind: "cancel-run",
      commandId: "c-drop",
      runId: "run-1",
      expectedRevision: 2,
    },
    "run-ended",
  ],
  [
    "the turn that exhausts the budget of its run",
    effectRequest({ commandId: "c-above", round: 2, units: 2 }).command,
    "budget-exhausted",
  ],
] as const)
  await test(`CLV-049 a dispatch-pending operation whose last attempt was blocked is cancelled in ${name}`, async () => {
    const directory = await temporaryDirectory();
    const { authority, destination } = await blockedScene(directory);
    const receipt = await sender(authority, { now: noon })(command, [
      "build the package",
    ]);
    assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
    const operation = await authority.effects.operation(operationId);
    assert.deepEqual(
      [operation?.status, operation?.reason, operation?.leaseGeneration],
      ["cancelled", reason, null],
    );
    assert.deepEqual(
      (await authority.events()).map((event) => event.type).slice(-1),
      ["operation.reconciled"],
    );
    assert.deepEqual(await outcomes(authority, operationId), ["blocked"]);
    assert.deepEqual(destination.effects, []);
    await authority.close();
    await (await openedAuthority(directory)).close();
  });

await test("CLV-049 the recovery send of a start in the queue does not occur when the available manifest differs from the stored pin", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  await sender(first, { now: noon })({ ...storedGate[0] });
  const [start] = await first.eligibleIntents();
  assert.ok(start);
  await first.close();
  const held = heldReconcile(fakeDestination(), "continue-run");
  const blocked = await openedAuthority(directory, {
    delivery: held.delivery,
    timing: fastTiming,
    available: () => changed,
  });
  await deliverUntil(
    blocked,
    async () => (await outcomes(blocked, start.operationId))[0] === "blocked",
  );
  assert.equal(held.sent.length, 0);
  assert.deepEqual(
    (await blocked.eligibleIntents()).map((intent) => intent.kind),
    ["start-run"],
  );
  await blocked.close();
  const restored = await openedAuthority(directory, {
    delivery: held.delivery,
    timing: fastTiming,
    available: (pinned) => pinned,
  });
  await deliverUntil(
    restored,
    async () => (await restored.eligibleIntents()).length === 0,
  );
  assert.deepEqual(
    held.sent.map((intent) => intent.kind),
    ["start-run"],
  );
  assert.deepEqual(await outcomes(restored, start.operationId), [
    "blocked",
    "sent",
  ]);
  await restored.close();
});

await test("CLV-049 a dispatch attempt that closes as blocked after the drop of its run cancels its operation in the callback turn", async () => {
  const destination = fakeDestination();
  const held = heldReconcile(destination, "protected-effect");
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: held.delivery,
    clock: () => noon,
    timing: fastTiming,
    available: () => changed,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  await send(request.command, request.documents);
  const settled = deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "cancelled",
  );
  await held.entered;
  const dropped = await send({
    kind: "cancel-run",
    commandId: "c-drop",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(dropped.kind, "accepted");
  held.release();
  await settled;
  assert.deepEqual(await outcomes(authority, operationId), ["blocked"]);
  assert.equal(
    (await authority.effects.operation(operationId))?.reason,
    "run-ended",
  );
  assert.deepEqual(destination.effects, []);
  await authority.close();
});
