import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import { record } from "../src/protocol.ts";
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
  readonly selfUpdateHold?: {
    readonly mark: string;
    readonly startedAt: number;
  };
}

export async function withQueue(
  options: QueueOptions,
  body: (scene: {
    readonly commands: () => Promise<readonly string[]>;
    readonly stop: () => Promise<void>;
    readonly directory: string;
  }) => Promise<void>,
): Promise<void> {
  return withHarness(async (harness) => {
    const directory = harness.stateDirectory;
    const file = join(directory, "queue-commands.json");
    await writeFile(
      file,
      JSON.stringify(
        options.failures === undefined && options.selfUpdateHold === undefined
          ? (options.commands ?? [])
          : {
              commands: options.commands ?? [],
              failures: options.failures ?? [],
              selfUpdateHold: options.selfUpdateHold,
            },
      ),
    );
    const listener = await listen({
      path: join(harness.runtimeDirectory, "control.sock"),
      handle: options.handle,
      limits: { idleMilliseconds: 5000 },
    });
    if (options.selfUpdateHold !== undefined)
      await writeFile(
        join(directory, "pending-self-update"),
        options.selfUpdateHold.mark,
      );
    const queue = issueQueue({
      workflowId: "develop-issue",
      directory,
      runtimeDirectory: harness.runtimeDirectory,
      intervalMilliseconds: options.intervalMilliseconds ?? 5,
      lanes: options.lanes ?? 1,
    });
    try {
      await body({
        directory,
        commands: () => queueCommands(file),
        stop: queue.stop,
      });
    } finally {
      await queue.stop();
      await listener.close();
    }
  });
}
