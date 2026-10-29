import assert from "node:assert/strict";
import { after, test } from "node:test";
import { removeTemporaryDirectories } from "./authority-store-fixture.ts";
import { deliverUntil } from "./authority-actor-fixture.ts";
import { operationOf, request } from "./effect-pure-fixture.ts";
import { fields, inputDigest } from "./command-wait-check-fixture.ts";
import { context, opening, startWaitRun } from "./command-wait-fixture.ts";
import { key, checkRequest, start } from "./command-wait-check-fixture.ts";
import { commandWaitScene, storedCheck } from "./command-wait-check-store.ts";

after(removeTemporaryDirectories);

await test("CLV-236 authority preserves the check schedule and a lost reply across three days of downtime", async () => {
  const scene = await commandWaitScene();
  let store = scene.store;
  try {
    await storedCheck(store, { commandId: "first-check", now: start });
    assert.equal(scene.calls.length, 1);
    assert.equal(
      scene.calls[0]?.commandDeadline,
      new Date(start + 2_592_000_000).toISOString(),
    );
    assert.equal(
      (await store.state()).commandWaits?.[key]?.nextCheckAt,
      start + 3_600_000,
    );
    await store.close();
    scene.clock.now += 3 * 86_400_000;
    store = await scene.reopen();
    const request = { ...checkRequest, commandId: "first-check" };
    assert.equal(
      (await store.execute(request, { ...context, epoch: store.epoch })).kind,
      "duplicate",
    );
    assert.equal(scene.calls.length, 1);
    await storedCheck(store, {
      commandId: "after-downtime",
      now: scene.clock.now,
    });
    assert.equal(scene.calls.length, 2);
    assert.equal((await store.state()).commandWaits?.[key]?.checkCount, 2);
    assert.equal(
      (await store.state()).commandWaits?.[key]?.nextCheckAt,
      scene.clock.now + 3_600_000,
    );
  } finally {
    await store.close();
  }
});

await test("CLV-236 a ready value is durable and joining a terminal wait starts no check", async () => {
  const scene = await commandWaitScene();
  let store = scene.store;
  try {
    scene.clock.output = '{"ready":true,"value":{"approved":true}}';
    await storedCheck(store, { commandId: "ready-check", now: start });
    assert.equal((await store.state()).commandWaits?.[key]?.state, "completed");
    assert.equal((await store.effects.budget("run-1"))?.spent, 0);
    await store.close();
    store = await scene.reopen();
    assert.equal(
      (await store.state()).commandWaits?.[key]?.result,
      '{"approved":true}',
    );
    assert.equal(
      (await store.state()).commandWaits?.[key]?.deadline,
      start + 2_592_000_000,
    );
    assert.equal(
      (await store.execute({ ...opening, commandId: "join-terminal" }, context))
        .kind,
      "accepted",
    );
    assert.equal(scene.calls.length, 1);
  } finally {
    await store.close();
  }
});

await test("CLV-236 a check admitted before its deadline but dispatched at it times out without a command", async () => {
  const scene = await commandWaitScene();
  const { store } = scene;
  try {
    assert.equal(
      (await store.execute(checkRequest, { ...context, epoch: store.epoch }))
        .kind,
      "accepted",
    );
    scene.clock.now = start + 2_592_000_000;
    await deliverUntil(
      store,
      async () =>
        (await store.state()).commandWaits?.[key]?.state === "timed-out",
    );
    assert.equal(scene.calls.length, 0);
    assert.equal(
      (await store.state()).commandWaits?.[key]?.reason,
      "command-wait-timeout",
    );
    assert.equal((await store.effects.budget("run-1"))?.spent, 0);
  } finally {
    await store.close();
  }
});

await test("CLV-236 a check promoted by another run retains its durable deadline", async () => {
  const scene = await commandWaitScene();
  const { store } = scene;
  try {
    await startWaitRun(store, { runId: "run-2" });
    const operationId = operationOf(1, "run-2");
    const ordinary = {
      ...request(1),
      ...fields,
      inputDigest,
      runId: "run-2",
      operationId,
    };
    assert.equal(
      (await store.execute(ordinary, { ...context, epoch: store.epoch })).kind,
      "accepted",
    );
    assert.equal(
      (await store.execute(checkRequest, { ...context, epoch: store.epoch }))
        .kind,
      "accepted",
    );
    await deliverUntil(
      store,
      async () =>
        (await store.state()).commandWaits?.[key]?.lastCheckSettledAt === start,
    );
    assert.equal(scene.calls.length, 2);
    const check = scene.calls.find((intent) => intent.runId === "run-1");
    assert.equal(
      check?.commandDeadline,
      new Date(start + 2_592_000_000).toISOString(),
    );
  } finally {
    await store.close();
  }
});
