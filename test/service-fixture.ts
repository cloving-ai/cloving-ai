import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import { send } from "../src/cli/client.ts";
import { record } from "../src/protocol.ts";
import {
  serviceTiming,
  startService,
  type Service,
  type ServiceOpening,
  type ServiceOptions,
  type ServiceTiming,
  type WorkflowRegistration,
} from "../src/service/service.ts";
import { manifest, quickCleanupTiming } from "./authority-store-fixture.ts";

import { digestOf } from "./digest-fixture.ts";

export { digestOf };

export const testTiming: ServiceTiming = {
  ...serviceTiming,
  authority: quickCleanupTiming,
  expiryScanMilliseconds: 50,
  followMilliseconds: 20,
};

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Harness {
  readonly stateDirectory: string;
  readonly runtimeDirectory: string;
  readonly projectDirectory: string;
  readonly sent: DeliveryIntent[];
  readonly resolved: unknown[];
  readonly registration: WorkflowRegistration;
  readonly start: (overrides?: Partial<ServiceOptions>) => Promise<Service>;
  readonly attempt: (
    overrides?: Partial<ServiceOptions>,
  ) => Promise<ServiceOpening>;
  readonly track: (opening: ServiceOpening) => ServiceOpening;
  readonly cli: (argumentsList: readonly string[]) => Promise<CliResult>;
  readonly cleanup: (action: () => void) => void;
}

export function fakeRegistration(resolved: unknown[]): WorkflowRegistration {
  return {
    workflowId: "develop",
    manifest,
    availability: "available",
    submission: { maximumBytes: 4096, fields: { prompt: "string" } },
    resolver: {
      id: "fake-resolver",
      version: "1",
      resolve: (request) => {
        resolved.push({
          workflowId: request.workflowId,
          submission: request.submission,
          commandId: request.commandId,
        });
        return Promise.resolve({
          kind: "resolved",
          input: { cycleId: `cycle-${String(resolved.length)}` },
        });
      },
    },
  };
}

export function runCli(
  argumentsList: readonly string[],
  environment: { readonly directory: string; readonly runtime: string },
): Promise<CliResult> {
  return new Promise((settle) => {
    const child = spawn(
      process.execPath,
      [resolve("src/cli.ts"), ...argumentsList],
      {
        cwd: environment.directory,
        env: { ...process.env, CLOVING_RUNTIME_DIR: environment.runtime },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (data: Buffer) => {
      output.stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output.stderr += data.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ status: code ?? -1, ...output });
    });
  });
}

function recordingDelivery(sent: DeliveryIntent[]): Delivery {
  return {
    reconcile: (intent) => {
      const index = sent.findIndex(
        (item) => item.operationId === intent.operationId,
      );
      return Promise.resolve(
        index < 0
          ? { kind: "absent" }
          : { kind: "accepted", receipt: `wrun-${String(index + 1)}` },
      );
    },
    deliver: (intent) => {
      sent.push(intent);
      return Promise.resolve({ receipt: `wrun-${String(sent.length)}` });
    },
  };
}

export function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

export function fields(value: unknown): Readonly<Record<string, unknown>> {
  return record(value) ?? {};
}

export async function withHarness<Result>(
  body: (harness: Harness) => Promise<Result>,
): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), "clv-"));
  const openServices = new Set<Service>();
  const cleanups: (() => void)[] = [];
  try {
    return await body(await serviceHarness({ root, openServices, cleanups }));
  } finally {
    for (const cleanup of cleanups) cleanup();
    await Promise.all(
      [...openServices].map((service) =>
        service.close().catch(() => undefined),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
}

function openings(
  openServices: Set<Service>,
  defaults: ServiceOptions,
): Pick<Harness, "track" | "attempt"> {
  const track = (opening: ServiceOpening): ServiceOpening => {
    if (opening.kind === "started") openServices.add(opening.service);
    return opening;
  };
  return {
    track,
    attempt: async (overrides = {}) =>
      track(await startService({ ...defaults, ...overrides })),
  };
}

async function serviceHarness(scope: {
  readonly root: string;
  readonly openServices: Set<Service>;
  readonly cleanups: (() => void)[];
}): Promise<Harness> {
  const { root, openServices, cleanups } = scope;
  const stateDirectory = join(root, "s");
  const runtimeDirectory = join(root, "r");
  const projectDirectory = join(root, "project with spaces");
  await mkdir(stateDirectory);
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await mkdir(projectDirectory);
  const sent: DeliveryIntent[] = [];
  const resolved: unknown[] = [];
  const registration = fakeRegistration(resolved);
  const { track, attempt } = openings(openServices, {
    stateDirectory,
    runtimeDirectory,
    workflows: [registration],
    delivery: recordingDelivery(sent),
    timing: testTiming,
  });
  return {
    stateDirectory,
    runtimeDirectory,
    projectDirectory,
    sent,
    resolved,
    registration,
    attempt,
    track,
    start: async (overrides = {}) => {
      const opening = await attempt(overrides);
      if (opening.kind !== "started")
        throw new Error(`${opening.reason}: ${opening.detail}`);
      const { service } = opening;
      return {
        ...service,
        close: async () => {
          openServices.delete(service);
          await service.close();
        },
      };
    },
    cli: (argumentsList) =>
      runCli(argumentsList, {
        directory: projectDirectory,
        runtime: runtimeDirectory,
      }),
    cleanup: (action) => {
      cleanups.push(action);
    },
  };
}

export const noon = "2026-10-10T12:00:00.000Z";
export const later = "2026-10-10T13:00:00.000Z";

export interface Waiting {
  readonly runId: string;
  readonly decisionId: string;
}

export async function admitted(
  harness: Harness,
  request:
    string | { readonly commandId: string; readonly workflowId?: string },
): Promise<string> {
  const commandId = typeof request === "string" ? request : request.commandId;
  const workflowId =
    typeof request === "string" ? "develop" : (request.workflowId ?? "develop");
  const before = harness.sent.length;
  const result = await call(harness, {
    operation: "run",
    parameters: {
      workflowId,
      source: "prompt",
      submission: { prompt: `task of ${commandId}` },
      commandId,
    },
  });
  await eventually(() => (harness.sent.length > before ? true : undefined));
  const runId = text(result, "runId");
  await eventually(async () => {
    const page = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 1000, runId },
    });
    return JSON.stringify(page).includes("step.dispatched") ? true : undefined;
  });
  return runId;
}

export async function startedRun(
  harness: Harness,
  running: {
    readonly service: Service;
    readonly commandId: string;
    readonly workflowId?: string;
  },
): Promise<string> {
  const runId = await admitted(harness, running);
  await running.service.worker.started({
    runId,
    commandId: `${running.commandId}-started`,
    expectedRevision: 1,
  });
  return runId;
}

export async function waitingGate(
  harness: Harness,
  opening: {
    readonly service: Service;
    readonly commandId: string;
    readonly kind: "question" | "approval";
    readonly expiresAt?: string;
  },
): Promise<Waiting> {
  const { service, commandId, kind } = opening;
  const runId = await startedRun(harness, { service, commandId });
  const prompt = `${kind} of ${commandId}?`;
  await service.worker.openGate({
    runId,
    commandId: `${commandId}-open`,
    expectedRevision: 2,
    gateId: "design-1",
    kind,
    prompt,
    subject: digestOf(prompt),
    ...(opening.expiresAt === undefined
      ? {}
      : { expiresAt: opening.expiresAt }),
  });
  await service.worker.registerWait({
    runId,
    commandId: `${commandId}-wait`,
    gateId: "design-1",
  });
  return { runId, decisionId: `${runId}/design-1` };
}

export function decide(
  harness: Harness,
  decision: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  return call(harness, {
    operation: "decision",
    parameters: {
      expectedRevision: 1,
      generation: 1,
      commandId: "c-decide",
      ...decision,
    },
  });
}

export async function call(
  harness: Pick<Harness, "runtimeDirectory">,
  request: {
    readonly operation: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  },
): Promise<Readonly<Record<string, unknown>>> {
  const limit = new AbortController();
  const late = delay(20_000, undefined, { signal: limit.signal }).then(() => {
    throw new Error(`no reply to ${request.operation}`);
  });
  try {
    const reply = await Promise.race([
      send(harness.runtimeDirectory, request),
      late,
    ]);
    return reply.kind === "result"
      ? reply.result
      : { kind: "error", ...reply.error };
  } finally {
    limit.abort();
  }
}

export async function eventually<Value>(
  read: () => Promise<Value | undefined> | Value | undefined,
): Promise<Value> {
  for (let waited = 0; waited < 10_000; waited += 20) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("condition-not-reached");
}

export function parsed(result: CliResult): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(result.stdout);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`not-an-object: ${result.stdout}`);
  return Object.fromEntries(Object.entries(value));
}

export function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

export function text(value: unknown, name: string): string {
  return String(field(value, name));
}
