import assert from "node:assert/strict";
import { test } from "node:test";
import {
  strandingWatchdog,
  type WatchedEvent,
  type WatchReport,
} from "../src/broker/actor/authority-watchdog.ts";

const lost = "solid_objects.activation.lost";
const dead = "solid_objects.dead_letter.created";
const completed = "solid_objects.message.completed";

function event(fields: {
  readonly name: string;
  readonly messageId: string | null;
  readonly operation?: string;
}): WatchedEvent {
  const { name, messageId, operation } = fields;
  return {
    name,
    messageId,
    attributes: operation === undefined ? {} : { operation },
  };
}

type RunStatuses = Readonly<Record<string, string>>;

interface Timed {
  readonly observeAt: (at: number, watched: WatchedEvent) => void;
  readonly reportAt: (
    at: number,
    runs?: RunStatuses,
  ) => Promise<WatchReport | undefined>;
  readonly lookups: readonly (readonly string[])[];
}

function timed(): Timed {
  const clock = { now: 0 };
  const lookups: (readonly string[])[] = [];
  const watchdog = strandingWatchdog({
    boundMilliseconds: 1_000,
    clock: () => clock.now,
  });
  return {
    observeAt: (at, watched) => {
      clock.now = at;
      watchdog.observe(watched);
    },
    reportAt: (at, runs = {}) => {
      clock.now = at;
      return watchdog.report((messageIds) => {
        lookups.push(messageIds);
        return Promise.resolve(
          new Map(
            Object.entries(runs).filter(([messageId]) =>
              messageIds.includes(messageId),
            ),
          ),
        );
      });
    },
    lookups,
  };
}

function stranded(messageId: string): WatchReport {
  return { kind: "stranded", messageId };
}

function deadLettered(messageId: string): WatchReport {
  return { kind: "dead-lettered", messageId };
}

function noRuns(): Promise<ReadonlyMap<string, string>> {
  return Promise.resolve(new Map());
}

async function afterClockStep(
  milliseconds: number,
  action: () => Promise<void>,
): Promise<void> {
  const systemClock = Date.now;
  Date.now = () => systemClock() + milliseconds;
  try {
    await action();
  } finally {
    Date.now = systemClock;
  }
}

await test("CLV-042 a message that stays unfinished longer than the bound after losing its activation is reported as stranded", async () => {
  const watchdog = timed();
  watchdog.observeAt(100, event({ name: lost, messageId: "message-1" }));
  assert.equal(await watchdog.reportAt(1_100), undefined);
  assert.deepEqual(await watchdog.reportAt(1_101), stranded("message-1"));
});

await test("CLV-042 a message that completes, fails or is rejected after losing its activation is not stranded", async () => {
  const watchdog = timed();
  for (const [index, finish] of [
    completed,
    "solid_objects.message.failed",
    "solid_objects.message.rejected",
  ].entries()) {
    const messageId = `message-${String(index)}`;
    watchdog.observeAt(0, event({ name: lost, messageId }));
    watchdog.observeAt(500, event({ name: finish, messageId }));
  }
  assert.equal(await watchdog.reportAt(10_000), undefined);
});

await test("CLV-042 the watchdog keeps the first loss time and ignores events without a message", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: null }));
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(900, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(
    900,
    event({ name: "solid_objects.message.started", messageId: "message-2" }),
  );
  assert.deepEqual(await watchdog.reportAt(1_001), stranded("message-1"));
});

await test("CLV-042 only a dead-lettered delivery callback is reported, because a message with a waiting caller reports its own failure to that caller", async () => {
  const watchdog = timed();
  for (const operation of ["execute", "beginEpoch", "recover", "adopt"])
    watchdog.observeAt(
      0,
      event({ name: dead, messageId: `message-${operation}`, operation }),
    );
  assert.equal(await watchdog.reportAt(0), undefined);
  watchdog.observeAt(
    0,
    event({ name: dead, messageId: "callback-1", operation: "deliveryFailed" }),
  );
  watchdog.observeAt(
    0,
    event({
      name: dead,
      messageId: "callback-2",
      operation: "deliveryCompleted",
    }),
  );
  assert.deepEqual(await watchdog.reportAt(0), deadLettered("callback-1"));
});

await test("CLV-053 the watchdog reports no stranded message for a message that completed after its bound and before a read", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(1_500, event({ name: completed, messageId: "message-1" }));
  watchdog.observeAt(1_600, event({ name: lost, messageId: "message-2" }));
  assert.equal(await watchdog.reportAt(1_700), undefined);
  assert.deepEqual(await watchdog.reportAt(2_601), stranded("message-2"));
});

await test("CLV-052 the watchdog with the clock of the product reports no stranded message immediately after a loss", async () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  watchdog.observe(event({ name: lost, messageId: "message-1" }));
  assert.equal(await watchdog.report(noRuns), undefined);
});

await test("CLV-052 the watchdog with the clock of the product reports no stranded message after a forward step of the system clock", async () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  watchdog.observe(event({ name: lost, messageId: "message-1" }));
  await afterClockStep(5_000, async () => {
    assert.equal(await watchdog.report(noRuns), undefined);
  });
});

await test("CLV-279 a stranded message stops the report when it finishes, with no restart", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  assert.deepEqual(await watchdog.reportAt(1_001), stranded("message-1"));
  watchdog.observeAt(1_002, event({ name: completed, messageId: "message-1" }));
  assert.equal(await watchdog.reportAt(1_003), undefined);
});

await test("CLV-053 the watchdog counts the bound from the first loss, also when the library tries the message again", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(
    500,
    event({ name: "solid_objects.recovery.reclaimed", messageId: "message-1" }),
  );
  watchdog.observeAt(
    500,
    event({ name: "solid_objects.message.started", messageId: "message-1" }),
  );
  assert.equal(await watchdog.reportAt(1_000), undefined);
  assert.deepEqual(await watchdog.reportAt(1_001), stranded("message-1"));
});

await test("CLV-053 the watchdog reports no stranded message for a turn that is longer than the bound and lost no activation", async () => {
  const watchdog = timed();
  watchdog.observeAt(
    0,
    event({ name: "solid_objects.message.started", messageId: "message-1" }),
  );
  assert.equal(await watchdog.reportAt(5_000), undefined);
});

await test("CLV-279 a lost message of a cancelled run is never reported, also after the authority forgets the run", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  assert.equal(
    await watchdog.reportAt(1_001, { "message-1": "cancelled" }),
    undefined,
  );
  assert.equal(await watchdog.reportAt(5_000), undefined);
});

await test("CLV-279 a stranded message of an active run is reported while it stays stranded", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  for (const at of [1_001, 5_000, 60_000])
    assert.deepEqual(
      await watchdog.reportAt(at, { "message-1": "running" }),
      stranded("message-1"),
    );
});

await test("CLV-279 a dead-lettered callback stops the report when the authority settles or cancels its run", async () => {
  const watchdog = timed();
  for (const messageId of ["completed", "failed", "running"])
    watchdog.observeAt(
      0,
      event({ name: dead, messageId, operation: "deliveryCompleted" }),
    );
  const runs = { completed: "completed", failed: "failed" };
  assert.deepEqual(
    await watchdog.reportAt(0, { ...runs, running: "running" }),
    deadLettered("running"),
  );
  assert.equal(await watchdog.reportAt(0, { running: "cancelled" }), undefined);
  assert.equal(await watchdog.reportAt(0), undefined);
});

await test("CLV-279 the watchdog reads the runs only of overdue and dead-lettered messages, and reads nothing without them", async () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(600, event({ name: lost, messageId: "message-2" }));
  assert.equal(await watchdog.reportAt(900), undefined);
  assert.deepEqual(watchdog.lookups, []);
  watchdog.observeAt(
    1_000,
    event({ name: dead, messageId: "callback-1", operation: "deliveryFailed" }),
  );
  assert.deepEqual(await watchdog.reportAt(1_001), deadLettered("callback-1"));
  assert.deepEqual(watchdog.lookups, [["callback-1", "message-1"]]);
});
