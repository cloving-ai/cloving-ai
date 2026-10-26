import { setTimeout as delay } from "node:timers/promises";
import { checkDecisions, type CheckContext } from "./decision-check.ts";
import { relayEvents } from "./relay-control.ts";

export interface WatchTiming {
  readonly pollMilliseconds: number;
  readonly reconnectMilliseconds: number;
}

export const watchTiming: WatchTiming = {
  pollMilliseconds: 60_000,
  reconnectMilliseconds: 5000,
};

export interface WatchContext extends CheckContext {
  readonly runtimeDirectory: string;
}

export interface DecisionWatch {
  readonly wake: () => void;
  readonly close: () => Promise<void>;
}

const gateEvents: ReadonlySet<string> = new Set([
  "gate.opened",
  "gate.decided",
  "gate.expired",
]);

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal }).catch(() => undefined);
}

async function followGates(
  context: WatchContext,
  stream: { readonly wake: () => void; readonly stopped: Promise<void> },
): Promise<void> {
  const page = await context.control({
    operation: "events",
    parameters: { after: 0, limit: 1 },
  });
  const latest = page.kind === "result" ? page.result["latestSequence"] : null;
  if (typeof latest !== "number") return;
  stream.wake();
  await relayEvents(context.runtimeDirectory, {
    after: latest,
    onEvent: (event) => {
      if (gateEvents.has(String(event["type"]))) stream.wake();
    },
    stopped: stream.stopped,
  });
}

export function watchDecisions(
  context: WatchContext,
  timing: WatchTiming,
): DecisionWatch {
  const stop = new AbortController();
  const stopped = new Promise<void>((settle) => {
    stop.signal.addEventListener("abort", () => {
      settle();
    });
  });
  const waking = { controller: new AbortController() };
  const wake = (): void => {
    waking.controller.abort();
  };
  const checking = (async () => {
    while (!stop.signal.aborted) {
      const current = waking.controller;
      await checkDecisions(context).catch(() => undefined);
      await pause(
        timing.pollMilliseconds,
        AbortSignal.any([stop.signal, current.signal]),
      );
      if (current.signal.aborted) waking.controller = new AbortController();
    }
  })();
  const following = (async () => {
    while (!stop.signal.aborted) {
      await followGates(context, { wake, stopped }).catch(() => undefined);
      wake();
      await pause(timing.reconnectMilliseconds, stop.signal);
    }
  })();
  return {
    wake,
    close: async () => {
      stop.abort();
      await Promise.all([checking, following]);
    },
  };
}
