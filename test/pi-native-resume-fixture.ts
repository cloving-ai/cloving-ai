import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  type Scene,
} from "./claude-worker-fixture.ts";
import { fakePi, piEvents, piMessage } from "./pi-fixture.ts";

const nextMessage = piMessage({ responseId: "new-response", timestamp: 2 });

export async function stoppedPi(
  scene: Scene,
  options: {
    readonly events?: readonly unknown[];
    readonly resumeEvents?: readonly unknown[];
    readonly resumeGate?: string;
    readonly model?: string;
  } = {},
) {
  const gate = join(scene.directory, "release");
  const settings = {
    profiles: {
      native: { harness: "pi", model: options.model ?? "operator/alias" },
    },
    tokenPrices: {
      "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
    },
    harness: {
      name: "pi",
      path: fakePi(scene, {
        gate,
        resumeEvents: piEvents(nextMessage),
        ...options,
      }),
    },
  };
  const signal = new AbortController().signal;
  const first = scene.worker("unused", settings);
  const call =
    options.model === undefined
      ? intent()
      : intent({ method: "run-turn:native" });
  await first.deliver(call, signal);
  await until(() => existsSync(join(scene.directory, "observed.json")));
  const started = record(scene, "operation-1/started.json");
  const session = field(started, "piSession");
  const processId = Number(field(field(started, "launch"), "processId"));
  const output = String(field(field(started, "launch"), "output"));
  await until(() => readFileSync(output, "utf8").includes('"message_end"'));
  await first.close();
  assert.equal(alive(processId), false);
  assert.equal(scene.reports.length, 0);
  return {
    signal,
    session,
    settings,
    call,
    next: scene.worker("unused", settings),
  };
}

export function prompts(scene: Scene) {
  return readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => resultOf(line));
}

export const historicalTool = {
  role: "toolResult",
  toolName: "bash",
  toolCallId: "historical-tool",
  isError: false,
  content: [{ type: "text", text: "Old tool output" }],
  usage: piMessage().usage,
};
