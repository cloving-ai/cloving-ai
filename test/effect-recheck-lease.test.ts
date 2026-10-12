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
import {
  effectRequest,
  fakeDestination,
  later,
  leaseExpiry,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";
import { heldReconcile } from "./effect-recheck-fixture.ts";

after(removeTemporaryDirectories);

const request = effectRequest({ commandId: "c-request", round: 1 });
const { operationId } = request;

await test("CLV-049 a change of the stored lease between the two reads of the handler withholds the send: after the expiry of the lease in that time, no send has the old generation", async () => {
  const destination = fakeDestination();
  const held = heldReconcile(destination, "protected-effect");
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: held.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  await send(request.command, request.documents);
  const running = deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === "running",
  );
  try {
    await held.entered;
    const expired = await authority.execute(leaseExpiry(request, 1), {
      recordedAt: later,
    });
    assert.equal(expired.kind, "accepted", JSON.stringify(expired));
    assert.equal(
      (await authority.effects.operation(operationId))?.status,
      "recovering",
    );
  } finally {
    held.release();
  }
  await running;
  assert.deepEqual(
    (await authority.operations())
      .filter((record) => record.operationId === operationId)
      .flatMap((record) =>
        record.deliveries.map((item) => [item.purpose, item.outcome]),
      ),
    [
      ["dispatch", "withheld"],
      ["dispatch", "accepted"],
    ],
  );
  assert.deepEqual(
    held.sent
      .filter((intent) => intent.kind === "protected-effect")
      .map((intent) => intent.leaseGeneration),
    [2],
  );
  assert.deepEqual(destination.effects, [operationId]);
  await authority.close();
});
