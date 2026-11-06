import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
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
import { digestOf } from "./digest-fixture.ts";
import {
  effectReport,
  effectRequest,
  fakeDestination,
  noon,
  runningRun,
  sender,
  type Request,
  type Send,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

async function opened(directory: string) {
  const destination = fakeDestination();
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  return { authority, destination, send: sender(authority, { now: noon }) };
}

function settled(authority: Authority): Promise<void> {
  return deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
}

async function reported(
  scene: { readonly authority: Authority; readonly send: Send },
  effect: { readonly request: Request; readonly outcome: object },
): Promise<void> {
  const { authority, send } = scene;
  const { request, outcome } = effect;
  assert.equal(
    (await send(request.command, request.documents)).kind,
    "accepted",
  );
  await settled(authority);
  const report = effectReport(request, {
    commandId: `c-report-${String(request.command["commandId"])}`,
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const receipt = await send(
    { ...report.command, ...outcome },
    report.documents,
  );
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
}

const failure = {
  outcome: "failed",
  result: undefined,
  reason: "git-call-failed",
};

await test("CLV-307 the stored authority gives a continuation the completed result of the old run, and a restart keeps it", async () => {
  const directory = await temporaryDirectory();
  const scene = await opened(directory);
  const { authority, destination, send } = scene;
  await runningRun(send, { effectLimit: 5 });
  const first = effectRequest({ commandId: "c-1", round: 1 });
  const merge = effectRequest({ commandId: "c-2", round: 2 });
  await reported(scene, { request: first, outcome: {} });
  await reported(scene, { request: merge, outcome: failure });
  const failed = await send({
    kind: "fail-run",
    commandId: "c-fail",
    runId: "run-1",
    expectedRevision: 2,
  });
  assert.equal(failed.kind, "accepted", JSON.stringify(failed));
  const start = (await authority.effects.operation(merge.operationId))
    ?.requestedSequence;
  assert.equal(typeof start, "number");
  await runningRun(
    (command, documents) =>
      send(
        command["kind"] === "admit-run"
          ? { ...command, continuedFrom: "run-1", reuseBefore: start }
          : command,
        documents,
      ),
    { effectLimit: 5, runId: "run-2" },
  );
  const reused = effectRequest({ commandId: "c-3", round: 1, runId: "run-2" });
  const receipt = await send(reused.command, reused.documents);
  assert.equal(Reflect.get(receipt, "disposition"), "existing");
  const operation = await authority.effects.operation(reused.operationId);
  assert.equal(operation?.status, "completed");
  assert.equal(operation.result, digestOf("the result"));
  assert.equal((await authority.effects.budget("run-2"))?.spent, 1);
  const again = effectRequest({ commandId: "c-4", round: 2, runId: "run-2" });
  assert.equal(
    Reflect.get(await send(again.command, again.documents), "disposition"),
    "admitted",
  );
  await settled(authority);
  assert.deepEqual(destination.effects, [
    first.operationId,
    merge.operationId,
    again.operationId,
  ]);
  await authority.close();
  const restarted = await opened(directory);
  assert.equal(
    (await restarted.authority.effects.operation(reused.operationId))?.status,
    "completed",
  );
  await restarted.authority.close();
});

await test("CLV-307 the stored authority refuses a continuation of an active run", async () => {
  const scene = await opened(await temporaryDirectory());
  await runningRun(scene.send, { effectLimit: 5 });
  const receipt = await scene.send({
    ...storedGate[0],
    runId: "run-2",
    commandId: "c-continue",
    effectLimit: 5,
    capabilities: JSON.stringify([...manifest.capabilities].sort()),
    continuedFrom: "run-1",
    reuseBefore: 1,
  });
  assert.deepEqual(
    [receipt.kind, Reflect.get(receipt, "reason")],
    ["rejected", "continued-run-active"],
  );
  await scene.authority.close();
});
