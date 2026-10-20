import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { notifyRuns } from "../src/daemon/notify.ts";
import { record, type Fields, type Reply } from "../src/protocol.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import { withHarness } from "./service-fixture.ts";

export function notifyReply(result: Fields): Promise<Reply> {
  return Promise.resolve({ kind: "result", result });
}

export const blockedRun = {
  runId: "run-blocked",
  workflowId: "develop-ticket",
  latestSequence: 1,
  state: "completed",
  outcome: { kind: "blocked", reason: "needs help" },
};

export async function withNotificationEnvironment(
  body: (environment: {
    now: number;
    readonly errors: string[];
  }) => Promise<void>,
): Promise<void> {
  const environment = { now: 1_800_000_000_000, errors: [] as string[] };
  const originalNow = Date.now;
  const originalWrite = process.stderr.write.bind(process.stderr);
  Date.now = () => environment.now;
  process.stderr.write = (chunk: string | Uint8Array) => {
    environment.errors.push(String(chunk));
    return true;
  };
  try {
    await body(environment);
  } finally {
    Date.now = originalNow;
    process.stderr.write = originalWrite;
  }
}

const recordingScript = `
import { appendFileSync, readFileSync, statSync } from "node:fs";
import assert from "node:assert/strict";
assert.equal(process.argv.length, 1);
let text = "";
for await (const chunk of process.stdin) text += chunk;
const message = JSON.parse(text);
const journal = JSON.parse(readFileSync("notify-events.json", "utf8"));
const entry = journal.entries.find(entry => JSON.stringify(entry.message) === JSON.stringify(message));
assert.ok(entry.key.startsWith(message.event + ":"));
assert.equal(entry.state, "pending");
assert.deepEqual(entry.message, message);
assert.equal(statSync("notify-events.json").mode & 0o777, 0o600);
appendFileSync("notifications", text);
`;

export async function notificationJournal(directory: string): Promise<{
  readonly version: number;
  readonly entries: readonly Fields[];
}> {
  const journal = record(
    JSON.parse(await readFile(join(directory, "notify-events.json"), "utf8")),
  );
  if (journal?.["version"] !== 1 || !Array.isArray(journal["entries"]))
    throw new Error("invalid-test-notification-journal");
  const entries = journal["entries"].map((value: unknown) => {
    const entry = record(value);
    if (entry === undefined) throw new Error("invalid-test-notification-entry");
    return entry;
  });
  return { version: 1, entries };
}

interface NotifierOptions {
  readonly handle: Handle;
  readonly record?: string | null;
  readonly script?: string;
  readonly command?: readonly string[];
}

interface NotifyScene {
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly directory: string;
  readonly notices: () => Promise<readonly Fields[]>;
}

async function notices(file: string): Promise<readonly Fields[]> {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)) ?? {});
}

export async function withNotifier(
  options: NotifierOptions,
  body: (scene: NotifyScene) => Promise<void>,
): Promise<void> {
  return withHarness(async (harness) => {
    const directory = harness.stateDirectory;
    const output = join(directory, "notifications");
    if (options.record !== null)
      await writeFile(
        join(directory, "notify-events.json"),
        options.record ?? "[]",
      );
    await writeFile(output, "");
    const listener = await listen({
      path: join(harness.runtimeDirectory, "control.sock"),
      handle: options.handle,
      limits: { idleMilliseconds: 5000 },
    });
    const settings = {
      directory,
      runtimeDirectory: harness.runtimeDirectory,
      command: options.command ?? [
        process.execPath,
        "-e",
        `process.chdir(${JSON.stringify(directory)});${options.script ?? recordingScript}`,
      ],
      intervalMilliseconds: 5,
    };
    let notifier = await notifyRuns(settings).catch(async (error: unknown) => {
      await listener.close();
      throw error;
    });
    try {
      await body({
        stop: () => notifier.stop(),
        restart: async () => {
          await notifier.stop();
          notifier = await notifyRuns(settings);
        },
        directory,
        notices: () => notices(output),
      });
    } finally {
      try {
        await notifier.stop();
      } finally {
        await listener.close();
      }
    }
  });
}
