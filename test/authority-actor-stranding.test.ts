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
  readUntil,
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
  assert.equal(after.reason, "authority-unavailable");
  assert.match(after.detail, /^stranded message [0-9a-f-]{36}$/);
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

const committed = /^sequence [12]$/;
const strandedRead =
  /^Error: authority-unavailable: stranded message [0-9a-f-]{36}$/;

function healthLines(lines: readonly string[]): readonly unknown[] {
  return lines
    .map((line): unknown => JSON.parse(line))
    .filter((entry) =>
      String(Reflect.get(Object(entry), "event")).startsWith("authority-"),
    )
    .map((entry): readonly unknown[] => [
      Reflect.get(Object(entry), "level"),
      Reflect.get(Object(entry), "event"),
    ]);
}

await test("CLV-279 a delivery callback whose turn is longer than the lease in each attempt makes the authority refuse commands while it stays stranded, and the next command succeeds after the callback finishes, with no restart", async () => {
  const service = externalService();
  const lines: string[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...service.options,
    timing,
    log: (line) => lines.push(line),
    ...eachTurnStalled("deliveryCompleted"),
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  const started = performance.now();
  const controller = new AbortController();
  const delivering = authority.deliver(controller.signal).then(
    () => "stopped",
    (error: unknown) => String(error),
  );
  try {
    assert.match(
      await readUntil(authority, (outcome) => outcome !== "sequence 1"),
      strandedRead,
    );
    assert.ok(performance.now() - started < testMilliseconds(2_500));
    const later = { ...admission, runId: "run-2", commandId: "c-2" };
    const refusal = await executePinned(authority, later);
    assert.equal(refusal.kind, "failed");
    assert.equal(refusal.reason, "authority-unavailable");
    assert.match(refusal.detail, /^stranded message [0-9a-f-]{36}$/);
    assert.equal(
      await readUntil(authority, (outcome) => !strandedRead.test(outcome)),
      "sequence 2",
    );
    assert.equal((await executePinned(authority, later)).kind, "accepted");
  } finally {
    controller.abort();
  }
  assert.equal(await delivering, "stopped");
  assert.deepEqual(
    service.sent.map((intent) => intent.runId),
    ["run-1", "run-2"],
  );
  assert.deepEqual(healthLines(lines), [
    ["warn", "authority-unhealthy"],
    ["info", "authority-recovered"],
  ]);
  await authority.close();
});

await test("CLV-279 a command whose turn is longer than the lease in each attempt, while the delivery waits for work, gets a failed receipt, the delivery run keeps running, and the command commits once when its turn finishes, with no restart", async () => {
  const service = externalService();
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...service.options,
    timing,
    ...eachTurnStalled("execute"),
  });
  const controller = new AbortController();
  const running = authority.deliver(controller.signal).then(
    () => "stopped",
    (error: unknown) => String(error),
  );
  try {
    await delay(testMilliseconds(400));
    const receipt = await executePinned(authority, admission);
    assert.equal(receipt.kind, "failed");
    assert.equal(receipt.reason, "authority-unavailable");
    assert.match(receipt.detail, /^SyncTimeout: /);
    assert.match(
      await readUntil(authority, (outcome) => committed.test(outcome)),
      committed,
    );
    assert.deepEqual(await executePinned(authority, admission), {
      kind: "duplicate",
      sequence: 1,
      intents: [start],
    });
  } finally {
    controller.abort();
  }
  assert.equal(await running, "stopped");
  assert.deepEqual(
    (await authority.events())
      .map((event) => event.commandId)
      .filter((commandId) => commandId === "c-1"),
    ["c-1"],
  );
  await authority.close();
});

await test("CLV-279 a delivery callback of a cancelled run that stays lost longer than the bound never makes the authority refuse reads", async () => {
  const service = externalService();
  const lines: string[] = [];
  const losses: number[] = [];
  const stalled = eachTurnStalled("deliveryCompleted");
  const authority = await openedAuthority(await temporaryDirectory(), {
    ...service.options,
    timing,
    log: (line) => lines.push(line),
    instrumentation: (event) => {
      if (event.name === lost) losses.push(performance.now());
      stalled.instrumentation?.(event);
    },
  });
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  const drop = {
    kind: "cancel-run",
    commandId: "c-drop",
    runId: "run-1",
    expectedRevision: 1,
  };
  assert.equal((await executePinned(authority, drop)).kind, "accepted");
  const controller = new AbortController();
  const delivering = authority.deliver(controller.signal);
  const outcomes = new Set<string>();
  try {
    const watched = performance.now() + testMilliseconds(2_500);
    while (performance.now() < watched) {
      outcomes.add(await readUntil(authority, () => true));
      await delay(testMilliseconds(50));
    }
  } finally {
    controller.abort();
  }
  await delivering;
  const [firstLoss] = losses;
  assert.ok(firstLoss !== undefined);
  assert.ok(
    performance.now() - firstLoss > timing.callTimeoutMilliseconds,
    String(losses),
  );
  assert.deepEqual(
    [...outcomes].filter((outcome) => !outcome.startsWith("sequence ")),
    [],
  );
  assert.deepEqual(healthLines(lines), []);
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
