import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import { record } from "../src/protocol.ts";
import type { QueueDrain } from "../src/queue-state.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import { withHarness } from "./service-fixture.ts";

async function queueCommands(file: string): Promise<readonly string[]> {
  const saved: unknown = JSON.parse(await readFile(file, "utf8"));
  const value = Array.isArray(saved) ? saved : record(saved)?.["commands"];
  assert.ok(Array.isArray(value));
  assert.ok(value.every((id): id is string => typeof id === "string"));
  return value;
}

interface QueueOptions {
  readonly handle: Handle;
  readonly commands?: readonly string[];
  readonly failures?: readonly string[];
  readonly intervalMilliseconds?: number;
  readonly lanes?: number;
  readonly readyCommand?: readonly string[];
  readonly selfUpdateHold?: {
    readonly mark: string;
    readonly startedAt: number;
  };
  readonly drain?: QueueDrain;
  readonly pendingRestart?: string;
  readonly resumeQueue?: boolean;
}

function savedJournal(options: QueueOptions): unknown {
  if (
    options.failures === undefined &&
    options.selfUpdateHold === undefined &&
    options.drain === undefined
  )
    return options.commands ?? [];
  return {
    commands: options.commands ?? [],
    failures: options.failures ?? [],
    selfUpdateHold: options.selfUpdateHold,
    drain: options.drain,
  };
}

async function writeMarks(
  directory: string,
  options: QueueOptions,
): Promise<void> {
  if (options.pendingRestart !== undefined)
    await writeFile(
      join(directory, "pending-restart-one"),
      options.pendingRestart,
    );
  if (options.resumeQueue === true)
    await writeFile(join(directory, "resume-queue"), "");
  if (options.selfUpdateHold !== undefined)
    await writeFile(
      join(directory, "pending-self-update"),
      options.selfUpdateHold.mark,
    );
}

export async function withQueue(
  options: QueueOptions,
  body: (scene: {
    readonly commands: () => Promise<readonly string[]>;
    readonly stop: () => Promise<void>;
    readonly directory: string;
    readonly control: ReturnType<typeof issueQueue>["port"]["control"];
  }) => Promise<void>,
): Promise<void> {
  return withHarness(async (harness) => {
    const directory = harness.stateDirectory;
    const file = join(directory, "queue-commands.json");
    await writeFile(file, JSON.stringify(savedJournal(options)));
    const listener = await listen({
      path: join(harness.runtimeDirectory, "control.sock"),
      handle: options.handle,
      limits: { idleMilliseconds: 5000 },
    });
    await writeMarks(directory, options);
    const queue = issueQueue({
      workflowId: "develop",
      directory,
      runtimeDirectory: harness.runtimeDirectory,
      intervalMilliseconds: options.intervalMilliseconds ?? 5,
      lanes: options.lanes ?? 1,
      ...(options.readyCommand === undefined
        ? {}
        : { readyCommand: options.readyCommand }),
    });
    try {
      await body({
        directory,
        commands: () => queueCommands(file),
        stop: queue.stop,
        control: queue.port.control,
      });
    } finally {
      await queue.stop();
      await listener.close();
    }
  });
}
