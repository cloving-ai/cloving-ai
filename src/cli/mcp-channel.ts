import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Alert } from "../alert-selection.ts";
import { channelMessage } from "../channel-message.ts";
import type { Fields } from "../protocol.ts";
import {
  alertScan,
  runAlerts,
  scheduleAlerts,
  type RunCache,
} from "./alert-reads.ts";
import { prunedSent, recordSent, sentEntries } from "./channel-journal.ts";
import { follow, send } from "./client.ts";

interface ChannelTiming {
  readonly retryMilliseconds: number;
  readonly scheduleMilliseconds: number;
  readonly burstMilliseconds: number;
}

export interface ChannelPlace {
  readonly runtimeDirectory: string;
  readonly privateTexts: readonly string[];
  readonly write: (message: Fields) => Promise<void>;
  readonly timing?: ChannelTiming;
}

interface Watch extends ChannelPlace {
  readonly timing: ChannelTiming;
  readonly sent: Set<string>;
  readonly cache: RunCache;
  readonly journal: string;
  readonly signal: AbortSignal;
  readonly stopped: Promise<void>;
}

const channelTiming: ChannelTiming = {
  retryMilliseconds: 1000,
  scheduleMilliseconds: 15_000,
  burstMilliseconds: 250,
};

function report(error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Channel read failed: ${JSON.stringify(reason)}\n`);
}

function alertRun(alert: Alert): string {
  return alert.kind === "schedule-stopped"
    ? String(alert.failedRunIds.at(-1))
    : String(alert.run["runId"]);
}

async function delivered(watch: Watch, alert: Alert): Promise<void> {
  if (watch.sent.has(alert.key)) return;
  watch.sent.add(alert.key);
  await watch.write({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: channelMessage(alert, watch.privateTexts),
  });
  await recordSent(watch.journal, { key: alert.key, runId: alertRun(alert) });
}

async function scanned(watch: Watch): Promise<void> {
  for (const key of (await sentEntries(watch.journal)).keys())
    watch.sent.add(key);
  const alerts = await alertScan(watch.runtimeDirectory, watch.cache);
  for (const alert of alerts) await delivered(watch, alert);
  const open = new Set(alerts.map((alert) => alert.key));
  await prunedSent(
    watch.journal,
    (entry) => open.has(entry.key) || watch.cache.has(entry.runId),
  );
}

async function scheduled(watch: Watch): Promise<void> {
  for (const alert of await scheduleAlerts(watch.runtimeDirectory))
    await delivered(watch, alert);
}

async function drained(watch: Watch, pending: Set<string>): Promise<void> {
  if (pending.size === 0) return;
  await delay(watch.timing.burstMilliseconds);
  for (const runId of pending) {
    pending.delete(runId);
    for (const alert of await runAlerts(watch.runtimeDirectory, runId))
      await delivered(watch, alert);
  }
  await scheduled(watch);
}

async function followed(watch: Watch): Promise<void> {
  const page = await send(watch.runtimeDirectory, {
    operation: "events",
    parameters: { limit: 1 },
  });
  if (page.kind === "error") return;
  await scanned(watch);
  const pending = new Set<string>();
  const queue = { chain: Promise.resolve() };
  const enqueue = (task: () => Promise<void>): void => {
    queue.chain = queue.chain.then(task).catch(report);
  };
  const timer = setInterval(() => {
    enqueue(() => scheduled(watch));
  }, watch.timing.scheduleMilliseconds);
  await follow(watch.runtimeDirectory, {
    request: {
      operation: "events",
      parameters: { after: page.result["latestSequence"], follow: true },
    },
    onEvent: (event) => {
      pending.add(String(event["runId"]));
      enqueue(() => drained(watch, pending));
    },
    signal: watch.stopped,
  });
  clearInterval(timer);
  await queue.chain;
}

async function watched(watch: Watch): Promise<void> {
  while (!watch.signal.aborted) {
    await followed(watch).catch(report);
    await delay(watch.timing.retryMilliseconds, undefined, {
      signal: watch.signal,
    }).catch(() => undefined);
  }
}

export function channelAlerts(place: ChannelPlace): {
  readonly stop: () => Promise<void>;
} {
  const stopping = new AbortController();
  const stopped = new Promise<void>((settle) => {
    stopping.signal.addEventListener("abort", () => {
      settle();
    });
  });
  const running = watched({
    timing: channelTiming,
    ...place,
    sent: new Set(),
    cache: new Map(),
    journal: join(place.runtimeDirectory, "channel-events.json"),
    signal: stopping.signal,
    stopped,
  });
  return {
    stop: async () => {
      stopping.abort();
      await running;
    },
  };
}

export function channelTexts(
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] | undefined {
  const given = environment["CLOVING_PRIVATE_TEXTS"];
  if (given === undefined) return [];
  try {
    const list: unknown = JSON.parse(given);
    if (Array.isArray(list) && list.every((text) => typeof text === "string"))
      return list.map(String);
  } catch {
    return undefined;
  }
  return undefined;
}
