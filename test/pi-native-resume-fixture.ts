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
import { claudeLimits } from "../src/daemon/claude-worker-parts.ts";
import { launchState } from "../src/daemon/detached-process.ts";
import { piRpcPriorFailure, rpcRecord } from "../src/daemon/pi-rpc-channel.ts";
import { recordedLaunch, type TurnLaunch } from "../src/turn-launch.ts";

const nextMessage = piMessage({ responseId: "new-response", timestamp: 2 });

interface PiOptions {
  readonly events?: readonly unknown[];
  readonly resumeEvents?: readonly unknown[];
  readonly resumeGate?: string;
  readonly model?: string;
}

export async function runningPi(scene: Scene, options: PiOptions = {}) {
  const gate = join(scene.directory, "release");
  const settings = {
    stopMilliseconds: claudeLimits.stopMilliseconds,
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
  const launch = recordedLaunch(field(started, "launch"));
  assert.ok(launch?.piRpc);
  await until(() =>
    readFileSync(launch.output, "utf8").includes('"message_end"'),
  );
  await until(() => initialObserved(launch));
  return { signal, session, settings, call, first, launch };
}

function initialObserved(launch: TurnLaunch): boolean {
  const receipt = rpcRecord(
    join(String(launch.piRpc), "receipts", "initial.json"),
  );
  return Object.entries({
    id: "initial",
    type: "prompt",
    marker: launch.marker,
    written: true,
    acknowledged: true,
    observed: true,
  }).every(([key, value]) => receipt?.[key] === value);
}

export async function stoppedPi(scene: Scene, options: PiOptions = {}) {
  const { signal, session, settings, call, first, launch } = await runningPi(
    scene,
    options,
  );
  await first.close();
  await confirmedShutdown(scene, launch);
  return {
    signal,
    session,
    settings,
    call,
    next: scene.worker("unused", settings),
  };
}

async function confirmedShutdown(scene: Scene, launch: TurnLaunch) {
  assert.equal(alive(launch.processId), false);
  assert.equal(await launchState(launch), "ended");
  const exit = resultOf(readFileSync(launch.exit, "utf8"));
  assert.deepEqual(
    [exit["processId"], exit["processStart"], exit["marker"]],
    [launch.processId, launch.processStart, launch.marker],
  );
  const attempt = record(scene, "operation-1/attempt-1.json");
  assert.equal(typeof field(attempt, "endedAt"), "string");
  const result = record(scene, "operation-1/result.json");
  assert.equal(field(result, "stoppedBy"), "daemon-shutdown");
  assert.equal(await piRpcPriorFailure(launch), undefined);
  assert.equal(scene.reports.length, 0);
}

export function accepted(reply: unknown): void {
  assert.equal(field(reply, "kind"), "accepted", JSON.stringify(reply));
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

export const systemSetupEvents = [
  ...piEvents().slice(0, 2),
  {
    type: "message_end",
    message: { role: "system", content: "Setup", timestamp: 1 },
  },
];
