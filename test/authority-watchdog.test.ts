import assert from "node:assert/strict";
import { test } from "node:test";
import {
  strandingWatchdog,
  type WatchedEvent,
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

interface Timed {
  readonly stops: number[];
  readonly observeAt: (at: number, watched: WatchedEvent) => void;
  readonly strandedAt: (at: number) => string | undefined;
  readonly deadLettered: () => string | undefined;
}

function timed(): Timed {
  const clock = { now: 0 };
  const stops: number[] = [];
  const watchdog = strandingWatchdog({
    boundMilliseconds: 1_000,
    clock: () => clock.now,
    whenStranded: () => {
      stops.push(clock.now);
    },
  });
  return {
    stops,
    observeAt: (at, watched) => {
      clock.now = at;
      watchdog.observe(watched);
    },
    strandedAt: (at) => {
      clock.now = at;
      return watchdog.stranded();
    },
    deadLettered: watchdog.deadLettered,
  };
}

function afterClockStep(milliseconds: number, action: () => void): void {
  const systemClock = Date.now;
  Date.now = () => systemClock() + milliseconds;
  try {
    action();
  } finally {
    Date.now = systemClock;
  }
}

await test("CLV-042 a message that stays unfinished longer than the bound after losing its activation is reported as stranded", () => {
  const watchdog = timed();
  watchdog.observeAt(100, event({ name: lost, messageId: "message-1" }));
  assert.equal(watchdog.strandedAt(1_100), undefined);
  assert.equal(watchdog.strandedAt(1_101), "message-1");
});

await test("CLV-042 a message that completes, fails or is rejected after losing its activation is not stranded", () => {
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
  assert.equal(watchdog.strandedAt(10_000), undefined);
});

await test("CLV-042 the watchdog keeps the first loss time and ignores events without a message", () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: null }));
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(900, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(
    900,
    event({ name: "solid_objects.message.started", messageId: "message-2" }),
  );
  assert.equal(watchdog.strandedAt(1_001), "message-1");
});

await test("CLV-042 only a dead-lettered delivery callback is reported, because a message with a waiting caller reports its own failure to that caller", () => {
  const watchdog = timed();
  for (const operation of ["execute", "beginEpoch", "recover", "adopt"])
    watchdog.observeAt(
      0,
      event({ name: dead, messageId: `message-${operation}`, operation }),
    );
  assert.equal(watchdog.deadLettered(), undefined);
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
  assert.equal(watchdog.deadLettered(), "callback-1");
});

await test("CLV-052 the watchdog calls the stop function at the first event of a message that it observes after the bound of a lost message, and not before", () => {
  const watchdog = timed();
  watchdog.observeAt(100, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(1_100, event({ name: lost, messageId: "message-1" }));
  assert.deepEqual(watchdog.stops, []);
  watchdog.observeAt(
    1_101,
    event({ name: "solid_objects.message.started", messageId: "message-2" }),
  );
  assert.deepEqual(watchdog.stops, [1_101]);
});

await test("CLV-052 the watchdog does not call the stop function for a message that completed after it lost its activation", () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(1_500, event({ name: completed, messageId: "message-1" }));
  watchdog.observeAt(1_600, event({ name: lost, messageId: "message-2" }));
  assert.deepEqual(watchdog.stops, []);
});

await test("CLV-052 the watchdog keeps a stranded message after its stop function ran, also when the message completes later", () => {
  const watchdog = timed();
  watchdog.observeAt(0, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(1_001, event({ name: lost, messageId: "message-1" }));
  watchdog.observeAt(1_002, event({ name: completed, messageId: "message-1" }));
  assert.deepEqual(watchdog.stops, [1_001, 1_002]);
  assert.equal(watchdog.strandedAt(1_003), "message-1");
  assert.equal(watchdog.strandedAt(0), "message-1");
});

await test("CLV-052 the watchdog with the clock of the product reports no stranded message immediately after a loss", () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  watchdog.observe(event({ name: lost, messageId: "message-1" }));
  assert.equal(watchdog.stranded(), undefined);
});

await test("CLV-052 the watchdog with the clock of the product reports no stranded message after a forward step of the system clock", () => {
  const stops: string[] = [];
  const watchdog = strandingWatchdog({
    boundMilliseconds: 1_000,
    whenStranded: () => {
      stops.push("stopped");
    },
  });
  watchdog.observe(event({ name: lost, messageId: "message-1" }));
  afterClockStep(5_000, () => {
    watchdog.observe(
      event({ name: "solid_objects.message.started", messageId: "message-1" }),
    );
    assert.equal(watchdog.stranded(), undefined);
  });
  assert.deepEqual(stops, []);
});
