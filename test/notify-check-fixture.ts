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
  state: "completed",
  outcome: { kind: "blocked", reason: "needs help" },
};

const recordingScript = `
import { appendFileSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
assert.equal(process.argv.length, 1);
let text = "";
for await (const chunk of process.stdin) text += chunk;
const message = JSON.parse(text);
assert.ok(JSON.parse(readFileSync("notify-events.json", "utf8")).includes(message.event + ":" + message.runId));
appendFileSync("notifications", text);
`;

export async function withNotifier(
  options: {
    readonly handle: Handle;
    readonly record?: string;
    readonly script?: string;
  },
  body: (scene: {
    readonly stop: () => Promise<void>;
    readonly directory: string;
    readonly notices: () => Promise<readonly Fields[]>;
  }) => Promise<void>,
): Promise<void> {
  return withHarness(async (harness) => {
    const directory = harness.stateDirectory;
    const output = join(directory, "notifications");
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
    const notifier = await notifyRuns({
      directory,
      runtimeDirectory: harness.runtimeDirectory,
      command: [
        process.execPath,
        "-e",
        `process.chdir(${JSON.stringify(directory)});${options.script ?? recordingScript}`,
      ],
      intervalMilliseconds: 5,
    });
    try {
      await body({
        ...notifier,
        directory,
        notices: async () =>
          (await readFile(output, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => record(JSON.parse(line)) ?? {}),
      });
    } finally {
      await notifier.stop();
      await listener.close();
    }
  });
}
