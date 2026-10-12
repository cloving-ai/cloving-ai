import assert from "node:assert/strict";
import { after, test } from "node:test";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
} from "../src/broker/actor/authority.ts";
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
  later,
  leaseExpiry,
  noon,
  runningRun,
  sender,
  type Request,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

const acceptance: AdapterOutcome = {
  kind: "accepted",
  receipt: "receipt-1",
  worker: "worker-1",
};

function adapter(reply: AdapterOutcome): Delivery {
  return {
    deliver: (intent) =>
      Promise.resolve(
        intent.kind === "protected-effect" ? reply : { receipt: "receipt-run" },
      ),
    reconcile: (intent) =>
      Promise.resolve(
        intent.kind === "protected-effect" && intent.purpose === "reconcile"
          ? reply
          : { kind: "absent" },
      ),
  };
}

const first = effectRequest({ commandId: "c-1", round: 1, runId: "run-1" });
const second = effectRequest({ commandId: "c-2", round: 1, runId: "run-2" });

interface Scene {
  readonly directory: string;
  readonly authority: Authority;
}

async function held(reply: AdapterOutcome, status: string): Promise<Scene> {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    delivery: adapter(reply),
    clock: () => noon,
    timing: fastTiming,
    effects: { capacity: 1 },
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5, runId: "run-1" });
  await runningRun(send, { effectLimit: 5, runId: "run-2" });
  await send(first.command, first.documents);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(first.operationId))?.status === status,
  );
  return { directory, authority };
}

async function waitsAcrossAnOpening(
  scene: Scene,
  holder: string,
): Promise<void> {
  const { directory, authority } = scene;
  const receipt = await sender(authority, { now: noon })(
    second.command,
    second.documents,
  );
  assert.equal(Reflect.get(receipt, "disposition"), "admitted");
  assert.deepEqual(await states(authority, [first, second]), [
    holder,
    "waiting",
  ]);
  await authority.close();
  const reopened = await openedAuthority(directory, {
    delivery: adapter({ kind: "unknown" }),
    clock: () => noon,
    timing: fastTiming,
    effects: { capacity: 1 },
  });
  assert.deepEqual(await states(reopened, [first, second]), [
    holder,
    "waiting",
  ]);
  await reopened.close();
}

async function states(
  authority: Authority,
  requests: readonly Request[],
): Promise<readonly unknown[]> {
  const found = [];
  for (const request of requests)
    found.push(
      (await authority.effects.operation(request.operationId))?.status,
    );
  return found;
}

await test("CLV-049 an operation that is blocked holds its capacity unit: with the bound 1, an operation of a different run waits, and a new opening works", async () => {
  const scene = await held({ kind: "unknown" }, "blocked");
  await waitsAcrossAnOpening(scene, "blocked");
});

await test("CLV-049 an operation that is recovering holds its capacity unit: with the bound 1, an operation of a different run waits, and a new opening works", async () => {
  const scene = await held(acceptance, "running");
  const expired = await scene.authority.execute(leaseExpiry(first, 1), {
    recordedAt: later,
  });
  assert.equal(expired.kind, "accepted", JSON.stringify(expired));
  await deliverUntil(scene.authority, async () =>
    (await scene.authority.operations()).some((record) =>
      record.deliveries.some(
        (item) => item.purpose === "reconcile" && item.outcome === "accepted",
      ),
    ),
  );
  await waitsAcrossAnOpening(scene, "recovering");
});
