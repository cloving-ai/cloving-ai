import assert from "node:assert/strict";
import { test } from "node:test";
import {
  strandingWatchdog,
  type WatchedEvent,
} from "../src/broker/actor/authority-watchdog.ts";

const lost = "solid_objects.activation.lost";
const dead = "solid_objects.dead_letter.created";

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

await test("CLV-042 a message that stays unfinished longer than the bound after losing its activation is reported as stranded", () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  watchdog.observe(event({ name: lost, messageId: "message-1" }), 100);
  assert.equal(watchdog.stranded(1_100), undefined);
  assert.equal(watchdog.stranded(1_101), "message-1");
});

await test("CLV-042 a message that completes, fails or is rejected after losing its activation is not stranded", () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  for (const [index, finish] of [
    "solid_objects.message.completed",
    "solid_objects.message.failed",
    "solid_objects.message.rejected",
  ].entries()) {
    watchdog.observe(
      event({ name: lost, messageId: `message-${String(index)}` }),
      0,
    );
    watchdog.observe(
      event({ name: finish, messageId: `message-${String(index)}` }),
      500,
    );
  }
  assert.equal(watchdog.stranded(10_000), undefined);
});

await test("CLV-042 the watchdog keeps the first loss time and ignores events without a message", () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  watchdog.observe(event({ name: lost, messageId: null }), 0);
  watchdog.observe(event({ name: lost, messageId: "message-1" }), 0);
  watchdog.observe(event({ name: lost, messageId: "message-1" }), 900);
  watchdog.observe(
    event({ name: "solid_objects.message.started", messageId: "message-2" }),
    0,
  );
  assert.equal(watchdog.stranded(1_001), "message-1");
});

await test("CLV-042 only a dead-lettered delivery callback is reported, because a message with a waiting caller reports its own failure to that caller", () => {
  const watchdog = strandingWatchdog({ boundMilliseconds: 1_000 });
  for (const operation of ["execute", "beginEpoch", "recover", "adopt"])
    watchdog.observe(
      event({ name: dead, messageId: `message-${operation}`, operation }),
      0,
    );
  assert.equal(watchdog.deadLettered(), undefined);
  watchdog.observe(
    event({ name: dead, messageId: "callback-1", operation: "deliveryFailed" }),
    0,
  );
  watchdog.observe(
    event({
      name: dead,
      messageId: "callback-2",
      operation: "deliveryCompleted",
    }),
    0,
  );
  assert.equal(watchdog.deadLettered(), "callback-1");
});
