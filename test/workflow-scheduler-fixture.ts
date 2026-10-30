import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workflowSchedules } from "../src/daemon/workflow-schedules.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import type { DeclaredWorkflow } from "../src/workflow-declaration.ts";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

export const scheduledWorkflow: DeclaredWorkflow = {
  workflowId: "review",
  functionName: "review",
  effectLimit: 1,
  capabilities: ["claude"],
  input: { maximumBytes: 1000, fields: { prompt: { type: "string" } } },
  schedule: { everySeconds: 300, input: { prompt: "current" } },
};

type Settings = Parameters<typeof workflowSchedules>[0];

interface SchedulerOptions {
  readonly initial?: unknown;
  readonly handle?: Handle;
  readonly submit?: Settings["submit"];
  readonly declarations?: readonly DeclaredWorkflow[];
}

const acceptedSkip: Settings["submit"] = () =>
  Promise.resolve({ kind: "accepted", sequence: 1, intents: [] });

export async function reached(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await delay(testMilliseconds(10));
  }
  throw new Error("schedule-condition-not-reached");
}

interface ScheduleScene {
  readonly requests: ServiceRequest[];
  readonly ticks: () => number;
  readonly errors: readonly string[];
  readonly file: string;
  readonly settings: Settings;
  readonly now: (milliseconds: number) => void;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly saved: () => Promise<string>;
  readonly control: (
    parameters: ServiceRequest["parameters"],
  ) => Promise<Reply>;
}

function capturedErrors(): {
  readonly errors: string[];
  readonly restore: () => void;
} {
  const errors: string[] = [];
  const output = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  };
  return {
    errors,
    restore: () => {
      process.stderr.write = output;
    },
  };
}

function controlledClock() {
  let now = 0;
  let ticks = 0;
  return {
    read: () => {
      ticks += 1;
      return now;
    },
    ticks: () => ticks,
    set: (value: number) => {
      now = value;
    },
  };
}

export async function withScheduler(
  options: SchedulerOptions,
  body: (scene: ScheduleScene) => Promise<void>,
): Promise<void> {
  await withFiles(
    options.initial === undefined
      ? {}
      : { "state/schedules.json": JSON.stringify(options.initial) },
    async (directory) => {
      await mkdir(join(directory, "state"), { recursive: true });
      const runtimeDirectory = join(directory, "run");
      await mkdir(runtimeDirectory, { mode: 0o700 });
      const requests: ServiceRequest[] = [];
      const listener = await listen({
        path: join(runtimeDirectory, "control.sock"),
        limits: { idleMilliseconds: 5000 },
        handle: async (request, connection) => {
          requests.push(request);
          return options.handle === undefined
            ? { kind: "result", result: { run: { state: "running" } } }
            : options.handle(request, connection);
        },
      });
      const clock = controlledClock();
      const settings = {
        directory,
        runtimeDirectory,
        declarations: options.declarations ?? [scheduledWorkflow],
        scheduleClock: clock.read,
        submit: options.submit ?? acceptedSkip,
      };
      let scheduler = await workflowSchedules(settings);
      const captured = capturedErrors();
      const file = join(directory, "state/schedules.json");
      try {
        await body({
          requests,
          ticks: clock.ticks,
          errors: captured.errors,
          file,
          settings,
          now: clock.set,
          stop: () => scheduler.stop(),
          control: (parameters) => scheduler.request(parameters),
          restart: async () => {
            await scheduler.stop();
            scheduler = await workflowSchedules(settings);
          },
          saved: () => readFile(file, "utf8"),
        });
      } finally {
        await scheduler.stop();
        captured.restore();
        await listener.close();
      }
    },
  );
}
