import {
  recordedNotifications,
  saveNotifications,
  type DeliveryEntry,
} from "./notify-journal.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { deliveryBackoffMilliseconds } from "../delivery-backoff.ts";
import type { Notification } from "./notify-message.ts";
import { notificationEvents, type OutcomeCache } from "./notify-events.ts";

interface NotifySettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly command: readonly string[];
  readonly intervalMilliseconds?: number;
}

const retentionMilliseconds = 7 * 24 * 60 * 60_000;

interface DeliveryJournal {
  readonly file: string;
  readonly entries: Map<string, DeliveryEntry>;
  readonly retiredKeys: Set<string>;
  readonly unsaved: Map<string, DeliveryEntry>;
}

interface DeliveryProgress {
  readonly stopping: AbortSignal;
  active: Promise<void> | undefined;
  completed: DeliveryEntry | undefined;
}

type DeliveryAttempt = DeliveryEntry & { readonly message: Notification };

async function flushNotifications(journal: DeliveryJournal): Promise<void> {
  if (journal.unsaved.size === 0) return;
  await saveNotifications(journal.file, journal);
  for (const entry of journal.unsaved.values())
    if (entry.state === "failed" && entry.attempts === 5)
      process.stderr.write(`Notify delivery failed: ${entry.key}\n`);
  journal.unsaved.clear();
}

async function finishDelivery(
  journal: DeliveryJournal,
  entry: DeliveryEntry,
): Promise<void> {
  journal.entries.set(entry.key, entry);
  journal.unsaved.set(entry.key, entry);
  await flushNotifications(journal);
}

export function notifyCommand(
  command: readonly string[],
  notification: Notification,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [executable = "", ...argumentsList] = command;
    const child = spawn(executable, argumentsList, {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal === null ? `exit code ${String(code)}` : `signal ${signal}`,
          ),
        );
    });
    child.stdin.end(JSON.stringify(notification) + "\n");
  });
}

function report(label: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${label}: ${JSON.stringify(reason)}\n`);
}

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return "command error";
  if ("code" in error && (error.code === "ENOENT" || error.code === "EACCES"))
    return `spawn ${error.code}`;
  return /^(?:exit code (?:\d+|null)|signal SIG[A-Z0-9]+)$/.test(error.message)
    ? error.message
    : "command error";
}

async function prepareDelivery(
  journal: DeliveryJournal,
  entry: DeliveryEntry,
): Promise<DeliveryAttempt | undefined> {
  if (entry.message === null || entry.state === "sent") return undefined;
  if (entry.attempts === 5 && entry.state === "pending")
    await finishDelivery(journal, {
      ...entry,
      state: "failed",
      lastFailure: "attempt interrupted",
    });
  if (entry.attempts === 5) return undefined;
  const backoff = deliveryBackoffMilliseconds[entry.attempts] ?? 0;
  if (
    entry.lastAttemptAt !== null &&
    Date.now() - entry.lastAttemptAt < backoff
  )
    return undefined;
  const pending: DeliveryAttempt = {
    ...entry,
    message: entry.message,
    state: "pending",
    attempts: entry.attempts + 1,
    lastAttemptAt: Date.now(),
  };
  const next = new Map(journal.entries).set(entry.key, pending);
  await saveNotifications(journal.file, { ...journal, entries: next });
  journal.entries.set(entry.key, pending);
  return pending;
}

async function deliver(
  settings: NotifySettings,
  entry: DeliveryAttempt,
): Promise<DeliveryEntry> {
  try {
    await notifyCommand(settings.command, entry.message);
    return { ...entry, state: "sent" };
  } catch (error) {
    return {
      ...entry,
      state: "failed",
      lastFailure: failureReason(error),
    };
  }
}

async function settleDelivery(
  journal: DeliveryJournal,
  progress: DeliveryProgress,
): Promise<void> {
  if (progress.completed !== undefined) {
    const entry = progress.completed;
    progress.completed = undefined;
    await finishDelivery(journal, entry);
  }
  await flushNotifications(journal);
}

async function scheduleDelivery(
  settings: NotifySettings,
  delivery: {
    readonly journal: DeliveryJournal;
    readonly progress: DeliveryProgress;
    readonly ready: () => void;
  },
): Promise<void> {
  const { journal, progress } = delivery;
  const stopped = (): boolean => progress.stopping.aborted;
  if (
    stopped() ||
    progress.active !== undefined ||
    progress.completed !== undefined ||
    journal.unsaved.size > 0
  )
    return;
  for (const entry of journal.entries.values()) {
    if (stopped()) return;
    const pending = await prepareDelivery(journal, entry);
    if (pending === undefined) continue;
    if (stopped()) {
      await finishDelivery(journal, entry);
      return;
    }
    progress.active = deliver(settings, pending).then((completed) => {
      progress.completed = completed;
      progress.active = undefined;
      delivery.ready();
    });
    return;
  }
}

async function check(
  settings: NotifySettings,
  journal: DeliveryJournal & {
    readonly cache: OutcomeCache;
  },
): Promise<void> {
  const retained = new Map(
    [...journal.entries].filter(
      ([, entry]) =>
        entry.state === "pending" ||
        (entry.state === "failed" && entry.attempts < 5) ||
        entry.lastAttemptAt === null ||
        entry.lastAttemptAt >= Date.now() - retentionMilliseconds,
    ),
  );
  const removed = [...journal.entries.keys()].filter(
    (key) => !retained.has(key),
  );
  if (removed.length > 0) {
    const retiredKeys = new Set([...journal.retiredKeys, ...removed]);
    await saveNotifications(journal.file, { entries: retained, retiredKeys });
    for (const key of removed) {
      journal.entries.delete(key);
      journal.retiredKeys.add(key);
    }
  }
  for (const event of await notificationEvents(
    settings.runtimeDirectory,
    journal.cache,
  )) {
    if (journal.entries.has(event.key) || journal.retiredKeys.has(event.key))
      continue;
    const entry: DeliveryEntry = {
      ...event,
      state: "pending",
      attempts: 0,
      lastAttemptAt: null,
      lastFailure: null,
    };
    journal.entries.set(event.key, entry);
    journal.unsaved.set(event.key, entry);
  }
  await flushNotifications(journal);
}

export async function notifyRuns(settings: NotifySettings): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const file = join(settings.directory, "notify-events.json");
  const recorded = await recordedNotifications(file);
  const cache: OutcomeCache = new Map();
  const journal = {
    file,
    entries: recorded?.entries ?? new Map<string, DeliveryEntry>(),
    retiredKeys: recorded?.retiredKeys ?? new Set<string>(),
    cache,
    unsaved: new Map<string, DeliveryEntry>(),
  };
  if (recorded === undefined) {
    for (const event of await notificationEvents(
      settings.runtimeDirectory,
      cache,
    ))
      journal.entries.set(event.key, {
        ...event,
        state: event.message.event === "schedule-stopped" ? "pending" : "sent",
        attempts: 0,
        lastAttemptAt:
          event.message.event === "schedule-stopped" ? null : Date.now(),
        lastFailure: null,
      });
  }
  await saveNotifications(file, journal);
  return notificationLoop(settings, journal);
}

function notificationLoop(
  settings: NotifySettings,
  journal: DeliveryJournal & { readonly cache: OutcomeCache },
): { readonly stop: () => Promise<void> } {
  let busy = false;
  let running = Promise.resolve();
  const stopping = new AbortController();
  const progress: DeliveryProgress = {
    stopping: stopping.signal,
    active: undefined,
    completed: undefined,
  };
  const ready = (): void => {
    if (stopping.signal.aborted) return;
    running = running
      .then(() => settleDelivery(journal, progress))
      .then(() => scheduleDelivery(settings, { journal, progress, ready }))
      .catch((error: unknown) => {
        report("Notify delivery failed", error);
      });
  };
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    running = running
      .then(() => settleDelivery(journal, progress))
      .then(() => check(settings, journal))
      .catch((error: unknown) => {
        report("Notify check failed", error);
      });
    ready();
    running = running.finally(() => {
      busy = false;
    });
  }, settings.intervalMilliseconds ?? 15_000);
  return {
    stop: () => {
      stopping.abort();
      clearInterval(timer);
      running = running
        .then(async () => {
          await progress.active;
          await settleDelivery(journal, progress);
        })
        .catch((error: unknown) => {
          report("Notify delivery failed", error);
        });
      return running;
    },
  };
}
