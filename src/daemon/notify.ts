import {
  recordedNotifications,
  saveNotifications,
  type DeliveryEntry,
} from "./notify-journal.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { send } from "../cli/client.ts";
import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import {
  decisionNotification,
  outcomeNotification,
  type Notification,
  type NotifyEvent,
} from "./notify-message.ts";

interface NotifySettings {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly command: readonly string[];
  readonly intervalMilliseconds?: number;
}

const retentionMilliseconds = 7 * 24 * 60 * 60_000;

async function request(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Fields> {
  const reply = await send(runtimeDirectory, request);
  if (reply.kind === "error") throw new Error(reply.error.code);
  return reply.result;
}

function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) throw new Error("invalid-notify-list");
  return value.map((item: unknown) => {
    const row = record(item);
    if (row === undefined) throw new Error("invalid-notify-row");
    return row;
  });
}

type OutcomeCache = Map<
  string,
  {
    readonly latestSequence: number;
    readonly event: NotifyEvent | undefined;
  }
>;

interface DeliveryJournal {
  readonly file: string;
  readonly entries: Map<string, DeliveryEntry>;
  readonly retiredKeys: Set<string>;
  readonly unsaved: Map<string, DeliveryEntry>;
}

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

async function observedOutcome(
  summary: Fields,
  source: { readonly runtimeDirectory: string; readonly cache: OutcomeCache },
): Promise<NotifyEvent | undefined> {
  const { runtimeDirectory, cache } = source;
  const latestSequence = summary["latestSequence"];
  if (typeof latestSequence !== "number")
    throw new Error("invalid-notify-sequence");
  const runId = String(summary["runId"]);
  const previous = cache.get(runId);
  if (previous !== undefined && previous.latestSequence === latestSequence)
    return previous.event;
  const status = await request(runtimeDirectory, {
    operation: "status",
    parameters: { runId },
  });
  const run = record(status["run"]);
  if (run === undefined) throw new Error("invalid-notify-status");
  const event = outcomeNotification(run);
  cache.set(runId, { latestSequence, event });
  return event;
}

async function events(
  runtimeDirectory: string,
  cache: OutcomeCache,
): Promise<readonly NotifyEvent[]> {
  const found: NotifyEvent[] = [];
  const runs = new Map<string, Fields>();
  let after: string | null = "";
  do {
    const page = await request(runtimeDirectory, {
      operation: "status",
      parameters: { after, limit: 500 },
    });
    for (const summary of rows(page["runs"])) {
      runs.set(String(summary["runId"]), summary);
      const outcome = await observedOutcome(summary, {
        runtimeDirectory,
        cache,
      });
      if (outcome !== undefined) found.push(outcome);
    }
    const next = page["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-notify-page");
    after = next;
  } while (after !== null);
  const questions = await request(runtimeDirectory, {
    operation: "questions",
    parameters: {},
  });
  for (const decision of rows(questions["decisions"])) {
    const run = runs.get(String(decision["runId"]));
    if (run !== undefined) found.push(decisionNotification(run, decision));
  }
  return found;
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

async function deliver(
  settings: NotifySettings,
  delivery: {
    readonly journal: DeliveryJournal;
    readonly entry: DeliveryEntry;
  },
): Promise<void> {
  const { journal, entry } = delivery;
  if (entry.message === null || entry.state === "sent") return;
  if (entry.attempts === 5) {
    if (entry.state === "pending")
      await finishDelivery(journal, {
        ...entry,
        state: "failed",
        lastFailure: "attempt interrupted",
      });
    return;
  }
  const backoff = [0, 60_000, 300_000, 900_000, 3_600_000][entry.attempts] ?? 0;
  if (
    entry.lastAttemptAt !== null &&
    Date.now() - entry.lastAttemptAt < backoff
  )
    return;
  const pending: DeliveryEntry = {
    ...entry,
    state: "pending",
    attempts: entry.attempts + 1,
    lastAttemptAt: Date.now(),
  };
  const next = new Map(journal.entries).set(entry.key, pending);
  await saveNotifications(journal.file, { ...journal, entries: next });
  journal.entries.set(entry.key, pending);
  let result: DeliveryEntry;
  try {
    await notifyCommand(settings.command, entry.message);
    result = { ...pending, state: "sent" };
  } catch (error) {
    result = {
      ...pending,
      state: "failed",
      lastFailure: failureReason(error),
    };
  }
  await finishDelivery(journal, result);
}

async function check(
  settings: NotifySettings,
  journal: DeliveryJournal & {
    readonly cache: OutcomeCache;
  },
): Promise<void> {
  await flushNotifications(journal);
  const retained = new Map(
    [...journal.entries].filter(
      ([, entry]) =>
        entry.state === "pending" ||
        (entry.state === "failed" && entry.attempts < 5) ||
        entry.lastAttemptAt === null ||
        entry.lastAttemptAt >= Date.now() - retentionMilliseconds,
    ),
  );
  if (retained.size !== journal.entries.size) {
    const retiredKeys = new Set([
      ...journal.retiredKeys,
      ...[...journal.entries.keys()].filter((key) => !retained.has(key)),
    ]);
    await saveNotifications(journal.file, { entries: retained, retiredKeys });
    for (const key of journal.entries.keys())
      if (!retained.has(key)) {
        journal.entries.delete(key);
        journal.retiredKeys.add(key);
      }
  }
  for (const entry of journal.entries.values())
    await deliver(settings, { journal, entry });
  for (const event of await events(settings.runtimeDirectory, journal.cache)) {
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
    await deliver(settings, { journal, entry });
  }
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
    for (const event of await events(settings.runtimeDirectory, cache))
      journal.entries.set(event.key, {
        ...event,
        state: "sent",
        attempts: 0,
        lastAttemptAt: Date.now(),
        lastFailure: null,
      });
  }
  await saveNotifications(file, journal);
  let busy = false;
  let running = Promise.resolve();
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    running = check(settings, journal)
      .catch((error: unknown) => {
        report("Notify check failed", error);
      })
      .finally(() => {
        busy = false;
      });
  }, settings.intervalMilliseconds ?? 15_000);
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
