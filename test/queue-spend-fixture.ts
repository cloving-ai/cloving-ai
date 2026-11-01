import assert from "node:assert/strict";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import type { WorkflowDeclaration } from "../src/workflow-declaration.ts";
import type { Fields } from "../src/protocol.ts";
import type { Service } from "../src/service/service.ts";
import type { Resolver } from "../src/service/registry.ts";
import { fakeDestination } from "./effect-fixture.ts";
import {
  call,
  eventually,
  field,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

export async function withQueueSpend(
  body: (
    scene: Awaited<ReturnType<typeof spendScene>> & {
      readonly messages: string[];
    },
  ) => Promise<void>,
  settings: {
    readonly limitUsd?: number;
    readonly issueResolver?: Resolver;
  } = {},
): Promise<void> {
  await withHarness(async (harness) => {
    const scene = await spendScene(harness, settings);
    const messages: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (line: string | Uint8Array) => {
      if (String(line).startsWith("Queue holding for spend limit")) {
        messages.push(String(line));
        return true;
      }
      return original(line);
    };
    try {
      await body({ ...scene, messages });
    } finally {
      await scene.stop();
      process.stderr.write = original;
    }
  });
}

async function spendScene(
  harness: Harness,
  settings: { readonly limitUsd?: number; readonly issueResolver?: Resolver },
) {
  const { workflow } = await writeDeclaredWorkflow(harness.projectDirectory);
  const clock = { now: "2026-10-10T12:00:00.000Z" };
  const counts = { admissions: 0, clockReads: 0 };
  const resolution = { wait: Promise.resolve() };
  const options = spendOptions(harness, {
    clock,
    counts,
    limitUsd: settings.limitUsd ?? 20,
    issueResolver: settings.issueResolver ?? {
      ...harness.registration.resolver,
      id: "declared-input",
    },
    resolution,
    workflow,
  });
  let service = await harness.start(options);
  let queue: ReturnType<typeof issueQueue> | undefined;
  const status = () =>
    call(harness, { operation: "status", parameters: { limit: 1 } });
  const startQueue = () => {
    queue = issueQueue({
      workflowId: workflow.workflowId,
      directory: harness.stateDirectory,
      runtimeDirectory: harness.runtimeDirectory,
      lanes: 2,
      intervalMilliseconds: 5,
    });
  };
  return {
    harness,
    clock,
    counts,
    resolution,
    registrations: options.workflows,
    status,
    startQueue,
    worker: () => service.worker,
    stop: async () => {
      await queue?.stop();
      await service.close();
    },
    restart: async (workflows = options.workflows) => {
      await queue?.stop();
      await service.close();
      service = await harness.start({ ...options, workflows });
      startQueue();
    },
    begin: async (name: string, workflowId = workflow.workflowId) =>
      begin(harness, { service, name, workflowId }),
    pendingTurn: (runId: string, round = 1) =>
      pendingTurn(service, { runId, round }),
    finish: (runId: string) => finish(harness, { service, runId }),
    turn: (runId: string, report: Fields) =>
      turn(service, { runId, report, round: 1 }),
  };
}

interface SpendState {
  readonly clock: { now: string };
  readonly counts: { admissions: number; clockReads: number };
  readonly limitUsd: number;
  readonly resolution: { wait: Promise<void> };
  readonly workflow: WorkflowDeclaration;
  readonly issueResolver: Resolver;
}

function spendOptions(harness: Harness, state: SpendState) {
  const { clock, counts, workflow } = state;
  const destination = fakeDestination({ lostReplies: 0 });
  const registration = {
    ...harness.registration,
    workflowId: workflow.workflowId,
    queue: workflow.queue ?? false,
    admission: 2,
    effectLimit: 20,
    manifest: {
      ...harness.registration.manifest,
      capabilities: ["claude"],
    },
    submission: {
      maximumBytes: 4096,
      fields: {
        ticket: { type: "ticket" as const, optional: true },
        prompt: { type: "string" as const, optional: true },
      },
    },
    resolver: {
      ...harness.registration.resolver,
      resolve: async () => {
        counts.admissions += 1;
        await state.resolution.wait;
        return {
          kind: "resolved" as const,
          input: { ticketId: String(counts.admissions) },
        };
      },
    },
  };
  return {
    workflows: [
      registration,
      {
        ...registration,
        workflowId: "queued",
        manifest: { ...registration.manifest, queue: true },
      },
      ...["manual", "develop-issue"].map((workflowId) => ({
        ...harness.registration,
        workflowId,
        resolver: state.issueResolver,
        effectLimit: 20,
        manifest: {
          ...harness.registration.manifest,
          capabilities: ["claude"],
        },
      })),
    ],
    delivery: destination.delivery,
    effects: { leaseMilliseconds: 4 * 3_600_000 },
    clock: () => {
      counts.clockReads += 1;
      return clock.now;
    },
    queueDailySpendLimitUsd: state.limitUsd,
  };
}

async function finish(
  harness: Harness,
  run: { readonly service: Service; readonly runId: string },
): Promise<void> {
  const { service, runId } = run;
  const shown = await call(harness, {
    operation: "status",
    parameters: { runId },
  });
  assert.equal(
    (
      await service.worker.submit({
        kind: "complete-run",
        commandId: `${runId}-finish`,
        runId,
        expectedRevision: field(shown["run"], "revision"),
        outcome: "handoff_requested",
      })
    ).kind,
    "accepted",
  );
}

async function begin(
  harness: Harness,
  run: {
    readonly service: Service;
    readonly name: string;
    readonly workflowId: string;
  },
): Promise<string> {
  const { service, name, workflowId } = run;
  const result = await call(harness, {
    operation: "run",
    parameters: {
      workflowId,
      source: "prompt",
      submission: { prompt: name },
      commandId: name,
    },
  });
  assert.equal(result["kind"], "run-admitted", JSON.stringify(result));
  const runId = String(result["runId"]);
  await eventually(async () => {
    const events = await call(harness, {
      operation: "events",
      parameters: { runId, after: 0, limit: 100 },
    });
    return JSON.stringify(events).includes("step.dispatched")
      ? true
      : undefined;
  });
  assert.equal(
    (
      await service.worker.started({
        runId,
        commandId: `${name}-started`,
        expectedRevision: 1,
      })
    ).kind,
    "accepted",
  );
  return runId;
}

async function turn(
  service: Service,
  given: {
    readonly runId: string;
    readonly report: Fields;
    readonly round: number;
  },
): Promise<void> {
  const report = await pendingTurn(service, given);
  await report(given.report);
}

async function pendingTurn(
  service: Service,
  given: { readonly runId: string; readonly round: number },
) {
  const { runId, round } = given;
  const request = {
    runId,
    commandId: `${runId}-turn-${String(round)}`,
    scope: { phase: "work", operation: "turn", round },
    capability: "claude",
    method: "run-turn",
    target: "workspace/main",
    payload: "Work",
    units: 1,
  };
  const reply = await service.worker.requestEffect(request);
  assert.ok(reply.operation);
  const operationId = reply.operation.operationId;
  const operation = await eventually(async () => {
    const observed = await service.worker.requestEffect(request);
    return observed.operation?.status === "running"
      ? observed.operation
      : undefined;
  });
  return async (report: Fields) => {
    const settled = await service.worker.reportEffect({
      runId,
      commandId: `${runId}-report-${String(round)}`,
      operationId,
      inputDigest: operation.inputDigest,
      leaseGeneration: Number(operation.leaseGeneration),
      worker: String(operation.worker),
      outcome: "completed",
      result: JSON.stringify(report),
    });
    assert.equal(
      settled.disposition?.disposition,
      "applied",
      JSON.stringify(settled),
    );
  };
}
