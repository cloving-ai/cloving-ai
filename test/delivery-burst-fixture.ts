import { setTimeout as delay } from "node:timers/promises";
import { type InstrumentationEvent } from "solid-objects";
import type { Authority, Delivery } from "../src/broker/actor/authority.ts";
import { executePinned, fastTiming } from "./authority-actor-fixture.ts";
import { storedGate } from "./authority-store-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const start = storedGate[0] ?? {};

const burstTiming = {
  ...fastTiming,
  leaseMilliseconds: testMilliseconds(1_000),
  renewalMilliseconds: testMilliseconds(250),
};

const silent: Delivery = {
  reconcile: () => Promise.resolve({ kind: "absent" }),
  deliver: () => Promise.resolve({ receipt: "receipt-1" }),
};

async function droppedRuns(authority: Authority, count: number): Promise<void> {
  for (let made = 0; made < count; made += 1) {
    const runId = `run-${String(made).padStart(4, "0")}`;
    await executePinned(authority, {
      ...start,
      runId,
      commandId: `c-admit-${runId}`,
    });
    await authority.execute(
      {
        kind: "cancel-run",
        commandId: `c-drop-${runId}`,
        runId,
        expectedRevision: 1,
      },
      { recordedAt: noon },
    );
  }
}

async function openRows(authority: Authority): Promise<number> {
  return (await authority.operations()).filter((record) =>
    record.deliveries.some((item) => item.outcome === null),
  ).length;
}

function completedDeliveries(events: readonly InstrumentationEvent[]): number {
  return new Set(
    events
      .filter(
        (event) =>
          event.name === "solid_objects.message.completed" &&
          event.attributes["operation"] === "deliveryCompleted",
      )
      .map((event) => event.messageId),
  ).size;
}

async function burst(
  authority: Authority,
  observation: {
    readonly events: readonly InstrumentationEvent[];
    readonly expected?: number;
  },
): Promise<readonly string[]> {
  const { events, expected = 1_000 } = observation;
  const controller = new AbortController();
  const failures: string[] = [];
  const running = authority
    .deliver(controller.signal)
    .catch((error: unknown) => {
      failures.push(String(Reflect.get(Object(error), "message")));
    });
  for (let round = 0; round < 600 && failures.length === 0; round += 1) {
    if (completedDeliveries(events) >= expected) break;
    await delay(testMilliseconds(50));
  }
  controller.abort();
  await running;
  return failures;
}

const lostEvent = "solid_objects.activation.lost";
const activationEvent = "solid_objects.activation.started";
const contextEvents = [
  "solid_objects.processes.cleaned",
  "solid_objects.recovery.reclaimed",
  "solid_objects.activation.failed",
  "solid_objects.message.failed",
  "solid_objects.message.retry",
  "solid_objects.sync.timeout",
];

function lostReport(events: readonly InstrumentationEvent[]): string {
  const first = events.findIndex((event) => event.name === lostEvent);
  const lost = events
    .filter((event) => event.name === lostEvent)
    .slice(0, 3)
    .map((event) => ({
      occurredAt: event.occurredAt,
      actorType: event.actorType,
      actorId: event.actorId,
      messageId: event.messageId,
      durationMilliseconds: event.attributes["durationMilliseconds"],
      operation: event.attributes["operation"],
    }));
  const counts = Object.fromEntries(
    contextEvents.map((name) => [
      name,
      events.filter((event) => event.name === name).length,
    ]),
  );
  const before = events
    .slice(Math.max(0, first - 15), Math.max(0, first))
    .map((event) => `${event.occurredAt} ${event.name}`);
  return JSON.stringify({ lost, counts, before }, null, 2);
}

function instrumentationWithStop(
  events: InstrumentationEvent[],
  stop: { readonly activation: number; readonly milliseconds: number },
): (event: InstrumentationEvent) => void {
  let activations = 0;
  return (event) => {
    events.push(event);
    if (event.name !== activationEvent) return;
    activations += 1;
    if (activations !== stop.activation) return;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      stop.milliseconds,
    );
  };
}

async function timerTurns(
  action: () => Promise<unknown>,
): Promise<{ readonly turns: number; readonly largestGap: number }> {
  const ticks = [performance.now()];
  const timer = setInterval(() => {
    ticks.push(performance.now());
  }, testMilliseconds(20));
  try {
    await action();
  } finally {
    clearInterval(timer);
  }
  const turns = ticks.length - 1;
  ticks.push(performance.now());
  const largestGap = Math.max(
    ...ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? tick)),
  );
  return { turns, largestGap };
}
export {
  activationEvent,
  burst,
  burstTiming,
  droppedRuns,
  instrumentationWithStop,
  lostEvent,
  lostReport,
  openRows,
  silent,
  start,
  timerTurns,
};
