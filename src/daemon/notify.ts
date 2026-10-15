import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
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

async function recorded(file: string): Promise<Set<string> | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((key) => typeof key === "string"))
    throw new Error("invalid-notify-record");
  return new Set(value.map(String));
}

async function save(file: string, keys: ReadonlySet<string>): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify([...keys]) + "\n", {
    mode: 0o600,
    flush: true,
  });
  await rename(`${file}.tmp`, file);
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

async function check(
  settings: NotifySettings,
  journal: {
    readonly file: string;
    readonly keys: Set<string>;
    readonly cache: OutcomeCache;
  },
): Promise<void> {
  for (const event of await events(settings.runtimeDirectory, journal.cache)) {
    if (journal.keys.has(event.key)) continue;
    await save(journal.file, new Set([...journal.keys, event.key]));
    journal.keys.add(event.key);
    await notifyCommand(settings.command, event.message).catch(
      (error: unknown) => {
        report("Notify command failed", error);
      },
    );
  }
}

export async function notifyRuns(settings: NotifySettings): Promise<{
  readonly stop: () => Promise<void>;
}> {
  const file = join(settings.directory, "notify-events.json");
  const keys = await recorded(file);
  const cache: OutcomeCache = new Map();
  const journal = { file, keys: keys ?? new Set<string>(), cache };
  if (keys === undefined) {
    for (const event of await events(settings.runtimeDirectory, cache))
      journal.keys.add(event.key);
    await save(file, journal.keys);
  }
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
