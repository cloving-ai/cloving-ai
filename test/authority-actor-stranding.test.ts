import { testMilliseconds } from "./test-timing.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import type { AuthorityOptions } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
  quickCleanupTiming,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
  testAuthorityTiming,
  withChild,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const start = {
  kind: "start-run",
  runId: "run-1",
  operationId:
    '["cloving-operation",0,"run-1","admission","start-run",null,null]',
};
const timing = {
  ...testAuthorityTiming,
  leaseMilliseconds: testMilliseconds(100),
  renewalMilliseconds: testMilliseconds(30),
  heartbeatMilliseconds: testMilliseconds(50),
  aliveThresholdMilliseconds: testMilliseconds(300),
  cleanupIntervalMilliseconds: testMilliseconds(100),
  callTimeoutMilliseconds: testMilliseconds(1_000),
};
const recoveringTiming = {
  ...timing,
  callTimeoutMilliseconds: testMilliseconds(3_000),
};
const lost = "solid_objects.activation.lost";

function count(events: readonly string[], name: string): number {
  return events.filter((event) => event === name).length;
}

function firstTurnsStalled(stall: {
  readonly operation: string;
  readonly events: string[];
  readonly turns: number;
}): Pick<AuthorityOptions, "instrumentation"> {
  let remaining = stall.turns;
  return {
    instrumentation: (event) => {
      stall.events.push(event.name);
      if (event.name !== "solid_objects.message.started") return;
      if (event.attributes["operation"] !== stall.operation) return;
      if (remaining === 0) return;
      remaining -= 1;
      const until = performance.now() + testMilliseconds(400);
      while (performance.now() < until);
    },
  };
}

function eachTurnStalled(
  operation: string,
): Pick<AuthorityOptions, "instrumentation"> {
  let end: number | undefined;
  return {
    instrumentation: (event) => {
      if (event.name !== "solid_objects.message.started") return;
      if (event.attributes["operation"] !== operation) return;
      end ??= performance.now() + testMilliseconds(3_000);
      const until = Math.min(performance.now() + testMilliseconds(400), end);
      while (performance.now() < until);
    },
  };
}

await test("CLV-052 a command whose turn is longer than the lease is accepted and applied one time, and the authority stays available with no restart", async () => {
  const events: string[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    timing,
    ...firstTurnsStalled({ operation: "execute", events, turns: 1 }),
  });
  const receipt = await executePinned(authority, admission);
  assert.equal(receipt.kind, "accepted");
  assert.equal(count(events, lost), 1);
  await delay(timing.callTimeoutMilliseconds + testMilliseconds(100));
  assert.equal((await authority.state()).sequence, 1);
  assert.deepEqual(await executePinned(authority, admission), {
    kind: "duplicate",
    sequence: 1,
    intents: [start],
  });
  const later = { ...admission, runId: "run-2", commandId: "c-2" };
  assert.equal((await executePinned(authority, later)).kind, "accepted");
  assert.deepEqual(
    (await authority.events()).map((event) => event.commandId),
    ["c-1", "c-2"],
  );
  await authority.close();
});

await test("CLV-052 a delivery callback whose turn is longer than the lease is applied one time with one send, and the authority stays available with no restart", async () => {
  const events: string[] = [];
  const service = externalService();
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...service.options,
    timing,
    ...firstTurnsStalled({
      operation: "deliveryCompleted",
      events,
      turns: 1,
    }),
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.equal(count(events, lost), 1);
  assert.equal(service.sent.length, 1);
  assert.deepEqual(
    (await authority.events()).map((event) => event.type),
    ["run.created", "step.dispatched"],
  );
  await delay(timing.callTimeoutMilliseconds + testMilliseconds(100));
  assert.equal((await authority.state()).sequence, 2);
  await authority.close();
});

await test("CLV-052 a delivery callback whose turn is longer than the lease in two attempts and then short is applied one time with one send, and the authority stays available with no restart", async () => {
  const events: string[] = [];
  const service = externalService();
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...service.options,
    timing: recoveringTiming,
    ...firstTurnsStalled({
      operation: "deliveryCompleted",
      events,
      turns: 2,
    }),
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  assert.equal(count(events, lost), 2);
  assert.equal(service.sent.length, 1);
  assert.deepEqual(
    (await authority.events()).map((event) => event.type),
    ["run.created", "step.dispatched"],
  );
  await delay(recoveringTiming.callTimeoutMilliseconds + testMilliseconds(100));
  assert.equal((await authority.state()).sequence, 2);
  await authority.close();
});

await test("CLV-052 a command whose turn is longer than the lease in each attempt is reported as a stranded message after the call timeout, and a restart commits it exactly once", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    timing,
    ...eachTurnStalled("execute"),
  });
  const receipt = await executePinned(authority, admission);
  assert.equal(receipt.kind, "failed");
  assert.equal(receipt.reason, "authority-unavailable");
  assert.match(
    receipt.detail,
    /^SyncTimeout: .* status=(claimed waitingOn=messageClaimed|ready waitingOn=notYetAvailable)$/,
  );
  await delay(timing.callTimeoutMilliseconds);
  const after = await executePinned(authority, admission);
  assert.equal(after.kind, "failed");
  assert.equal(after.reason, "storage-unavailable");
  assert.match(after.detail, /^closed after stranded message [0-9a-f-]{36}$/);
  await assert.rejects(
    authority.state(),
    /^Error: authority-unavailable: stranded message [0-9a-f-]{36}$/,
  );
  await authority.close();
  const restarted = await openedAuthority(directory);
  assert.deepEqual(
    (await restarted.events()).map((event) => event.commandId),
    ["c-1"],
  );
  assert.deepEqual(await executePinned(restarted, admission), {
    kind: "duplicate",
    sequence: 1,
    intents: [start],
  });
  await restarted.close();
});

await test("CLV-052 a delivery callback whose turn is longer than the lease in each attempt fails the authority closed within the bound, and a restart applies it exactly once", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const authority = await openedAuthority(directory, {
    ...service.options,
    timing,
    ...eachTurnStalled("deliveryCompleted"),
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  const started = performance.now();
  const controller = new AbortController();
  const outcome = await Promise.race([
    authority.deliver(controller.signal).then(
      () => "stopped",
      (error: unknown) => String(error),
    ),
    delay(testMilliseconds(5_000), "not detected", { ref: false }),
  ]);
  controller.abort();
  assert.match(outcome, /authority-unavailable: stranded message /);
  assert.ok(performance.now() - started < testMilliseconds(2_500));
  await assert.rejects(authority.state(), /authority-unavailable/);
  await authority.close();
  const restarted = await openedAuthority(directory, service.options);
  await deliverUntil(
    restarted,
    async () => (await restarted.eligibleIntents()).length === 0,
  );
  assert.equal(service.sent.length, 1);
  assert.deepEqual(
    (await restarted.events()).map((event) => event.type),
    ["run.created", "step.dispatched"],
  );
  await restarted.close();
});

await test("CLV-052 a command whose turn is longer than the lease in each attempt, while the delivery waits for work, gets a failed receipt, and the delivery run fails closed within the bound", async () => {
  const service = externalService();
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...service.options,
    timing,
    ...eachTurnStalled("execute"),
  });
  const controller = new AbortController();
  const started = performance.now();
  const running = authority.deliver(controller.signal).then(
    () => "stopped",
    (error: unknown) => String(error),
  );
  await delay(testMilliseconds(400));
  const receipt = await executePinned(authority, admission);
  const answered = performance.now();
  const outcome = await Promise.race([
    running,
    delay(testMilliseconds(5_000), "not detected", { ref: false }),
  ]);
  const stopped = performance.now();
  controller.abort();
  assert.equal(receipt.kind, "failed");
  assert.equal(receipt.reason, "authority-unavailable");
  assert.match(
    outcome,
    /^Error: authority-unavailable: (authority failure|stranded message [0-9a-f-]{36})$/,
  );
  assert.ok(
    stopped - answered < testMilliseconds(250),
    String(stopped - answered),
  );
  assert.ok(stopped - started < testMilliseconds(2_900));
  await assert.rejects(authority.state(), /authority-unavailable/);
  await authority.close();
});

await test("CLV-042 a command stranded by a process that then dies is committed exactly once by the next opening in a new process", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "authority-actor-child.ts", parameters: [directory, "strand"] },
    async (child) => {
      await child.waitFor("activation-lost");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  const started = performance.now();
  const authority = await openedAuthority(directory, {
    timing: quickCleanupTiming,
  });
  assert.ok(performance.now() - started < testMilliseconds(8_000));
  assert.deepEqual(
    (await authority.events()).map((event) => event.commandId),
    ["c-1"],
  );
  assert.deepEqual(await executePinned(authority, admission), {
    kind: "duplicate",
    sequence: 1,
    intents: [start],
  });
  await authority.close();
});

after(removeTemporaryDirectories);
