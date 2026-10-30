import { commandWaitBridge, type CommandWaitPorts } from "./command-wait.ts";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getStepMetadata, getWorkflowMetadata } from "workflow";
import {
  openBridgeGate,
  waitForBridgeDecision,
  type GateOpening,
  type GateReceipt,
  type WaitRegistration,
} from "./gate-bridge.ts";
export type {
  GateOpening,
  GateReceipt,
  WaitRegistration,
} from "./gate-bridge.ts";
import { runWait, type RunWaitPorts } from "./run-wait.ts";
import { reconciledDecision } from "./decision-resume.ts";
import { taggedRuns } from "./world-runs.ts";
import {
  stepBridgeKey,
  type GateRequest,
  type GateResult,
  type ProtectedRequest,
  type ProtectedResult,
  type StepBridge,
} from "../step-bridge.ts";

export interface StepCall {
  readonly worldRunId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly startedAt?: number;
}

export function sdkStepCall(): StepCall {
  const { stepId, attempt, stepStartedAt } = getStepMetadata();
  return {
    worldRunId: getWorkflowMetadata().workflowRunId,
    stepId,
    attempt,
    startedAt: stepStartedAt.getTime(),
  };
}

export interface OperationRead {
  readonly operationId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly receipt: string | null;
  readonly result: string | null;
}

export interface BridgeReply {
  readonly receipt: { readonly kind: string; readonly reason?: string };
  readonly disposition: {
    readonly disposition: string;
    readonly reason: string | null;
  } | null;
  readonly operation: OperationRead | null;
}

interface BridgeIdentity {
  readonly commandId: string;
  readonly transport: string;
}

export interface BridgeRequest extends ProtectedRequest, BridgeIdentity {
  readonly runId: string;
}

export interface BridgeTiming {
  readonly lookupTries: number;
  readonly pollMilliseconds: number;
  readonly retryMilliseconds: number;
}

export const bridgeTiming: BridgeTiming = {
  lookupTries: 250,
  pollMilliseconds: 20,
  retryMilliseconds: 1000,
};

export interface BridgePorts {
  readonly commandWait?: CommandWaitPorts;
  readonly decisionReceived?: (
    runId: string,
    gateId: string,
  ) => Promise<boolean>;
  readonly runWait?: RunWaitPorts;
  readonly call: () => StepCall;
  readonly run: (
    worldRunId: string,
  ) => Promise<{ readonly runId: string } | undefined>;
  readonly timing?: BridgeTiming;
  readonly stopped: AbortSignal;
  readonly state: () => Promise<{
    readonly runs: Readonly<
      Record<
        string,
        { readonly status: string; readonly revision: number } | undefined
      >
    >;
    readonly gates: Readonly<Record<string, unknown>>;
  }>;
  readonly openGate: (opening: GateOpening) => Promise<GateReceipt>;
  readonly registerWait: (wait: WaitRegistration) => Promise<GateReceipt>;
  readonly requestEffect: (request: BridgeRequest) => Promise<BridgeReply>;
  readonly operation: (
    operationId: string,
  ) => Promise<OperationRead | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
}

interface Hold {
  readonly ports: BridgePorts;
  readonly timing: BridgeTiming;
}

interface Admitted {
  readonly kind: "admitted";
  readonly operationId: string;
}

const committed = ["accepted", "duplicate"];
const ended = ["failed", "stopped", "blocked", "cancelled"] as const;

async function paused(hold: Hold, milliseconds: number): Promise<void> {
  const { stopped } = hold.ports;
  await delay(milliseconds, undefined, { signal: stopped }).catch(
    () => undefined,
  );
  if (stopped.aborted) await new Promise<never>(() => undefined);
}

function answered(reply: BridgeReply): Admitted | ProtectedResult | undefined {
  const { receipt, disposition, operation } = reply;
  const busy = receipt.kind === "rejected" && receipt.reason === "service-busy";
  if (receipt.kind === "failed" || busy) return undefined;
  if (!committed.includes(receipt.kind))
    return { kind: "refused", reason: receipt.reason ?? receipt.kind };
  if (disposition?.disposition === "refused")
    return { kind: "refused", reason: disposition.reason ?? "refused" };
  if (operation === null) return undefined;
  return { kind: "admitted", operationId: operation.operationId };
}

async function requested(
  hold: Hold,
  request: BridgeRequest,
): Promise<Admitted | ProtectedResult> {
  for (;;) {
    await paused(hold, 0);
    const answer = await hold.ports
      .requestEffect(request)
      .then(answered, () => undefined);
    if (answer !== undefined) return answer;
    await paused(hold, hold.timing.retryMilliseconds);
  }
}

async function text(hold: Hold, digest: string | null): Promise<string | null> {
  if (digest === null) return null;
  for (;;) {
    const read = await hold.ports.document(digest).then(
      (value) => ({ value: value ?? null }),
      () => undefined,
    );
    if (read !== undefined) return read.value;
    await paused(hold, hold.timing.retryMilliseconds);
  }
}

async function outcome(
  hold: Hold,
  operation: OperationRead,
): Promise<ProtectedResult | undefined> {
  const { operationId, status, reason, receipt, result } = operation;
  if (status === "refused")
    return { kind: "refused", reason: reason ?? "refused" };
  const end = ended.find((kind) => kind === status);
  if (end !== undefined) return { kind: end, operationId, reason };
  if (status !== "completed") return undefined;
  return {
    kind: "completed",
    operationId,
    receipt,
    result: await text(hold, result),
  };
}

async function settled(
  hold: Hold,
  operationId: string,
): Promise<ProtectedResult> {
  for (;;) {
    const operation = await hold.ports
      .operation(operationId)
      .catch(() => undefined);
    const result =
      operation === undefined ? undefined : await outcome(hold, operation);
    if (result !== undefined) return result;
    await paused(
      hold,
      operation === undefined
        ? hold.timing.retryMilliseconds
        : hold.timing.pollMilliseconds,
    );
  }
}

async function located(
  hold: Hold,
  worldRunId: string,
): Promise<{ readonly runId: string } | undefined> {
  const tries = hold.timing.lookupTries;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const world = await hold.ports.run(worldRunId);
    if (world !== undefined || attempt === tries) return world;
    await paused(hold, hold.timing.pollMilliseconds);
  }
  return undefined;
}

async function inWork(hold: Hold, runId: string): Promise<void> {
  for (;;) {
    const state = await hold.ports.state().catch(() => undefined);
    if (state !== undefined && state.runs[runId]?.status !== "queued") return;
    await paused(
      hold,
      state === undefined
        ? hold.timing.retryMilliseconds
        : hold.timing.pollMilliseconds,
    );
  }
}

function transportOf(call: StepCall): string {
  return `sdk:${call.stepId}`.replace(/[^A-Za-z0-9._:/-]/g, "-");
}

function identity(call: StepCall, request: ProtectedRequest): BridgeIdentity {
  const transport = transportOf(call);
  const scope = createHash("sha256")
    .update(JSON.stringify(request.scope))
    .digest("hex")
    .slice(0, 16);
  return { transport, commandId: `${transport}:${scope}` };
}

async function effect(
  hold: Hold,
  request: ProtectedRequest,
): Promise<ProtectedResult> {
  const call = hold.ports.call();
  const world = await located(hold, call.worldRunId);
  if (world === undefined)
    return { kind: "unavailable", reason: "unknown-world-run" };
  await inWork(hold, world.runId);
  const answer = await requested(hold, {
    ...request,
    ...identity(call, request),
    runId: world.runId,
  });
  if (answer.kind !== "admitted") return answer;
  return await settled(hold, answer.operationId);
}

async function gateSubject(hold: Hold, request: GateRequest) {
  const call = hold.ports.call();
  const world = await located(hold, call.worldRunId);
  if (world === undefined) return undefined;
  await inWork(hold, world.runId);
  return {
    request,
    runId: world.runId,
    transport: transportOf(call),
  };
}

async function gate(hold: Hold, request: GateRequest): Promise<GateResult> {
  const subject = await gateSubject(hold, request);
  if (subject === undefined)
    return { kind: "unavailable", reason: "unknown-world-run" };
  return await openBridgeGate(hold.ports, subject);
}

function hostCommandWait(hold: Hold) {
  return commandWaitBridge({
    ...(hold.ports.commandWait === undefined
      ? {}
      : { commandWait: hold.ports.commandWait }),
    stopped: hold.ports.stopped,
    pollMilliseconds: hold.timing.pollMilliseconds,
    retryMilliseconds: hold.timing.retryMilliseconds,
    runStatus: async (runId) => (await hold.ports.state()).runs[runId]?.status,
    subject: async () => {
      const call = hold.ports.call();
      const world = await located(hold, call.worldRunId);
      if (world === undefined) return undefined;
      await inWork(hold, world.runId);
      return { runId: world.runId, commandId: transportOf(call) };
    },
  });
}

export function stepBridge(ports: BridgePorts): StepBridge {
  const hold = { ports, timing: ports.timing ?? bridgeTiming };
  return {
    ...hostCommandWait(hold),
    effect: (request) => effect(hold, request),
    gate: (request) => gate(hold, request),
    waitForDecision: async (request) => {
      const subject = await gateSubject(hold, request);
      if (subject === undefined) throw new Error("unknown-world-run");
      return await waitForBridgeDecision(
        {
          ...ports,
          decisionReceived:
            ports.decisionReceived ??
            (async (runId, gateId) =>
              (
                await reconciledDecision(
                  { runs: taggedRuns, document: ports.document },
                  { runId, gateId },
                )
              ).kind === "accepted"),
        },
        subject,
      );
    },
    waitForRun: async (request) => {
      const call = ports.call();
      const world = await located(hold, call.worldRunId);
      if (
        world === undefined ||
        ports.runWait === undefined ||
        call.startedAt === undefined
      )
        throw new Error("cloving-host-unavailable");
      await inWork(hold, world.runId);
      return await runWait(ports.runWait, {
        caller: { ...world, stepId: call.stepId, startedAt: call.startedAt },
        request,
      });
    },
    handoff: (request) =>
      effect(hold, {
        scope: {
          phase: "handoff",
          operation: "handoff",
          round: 1,
          key: createHash("sha256").update(ports.call().stepId).digest("hex"),
        },
        capability: "handoff",
        method: "run",
        target: request.workflowId,
        payload: JSON.stringify(request.input),
        units: 1,
      }),
  };
}

export function registerStepBridge(bridge: StepBridge): () => void {
  const key = Symbol.for(stepBridgeKey);
  Reflect.set(globalThis, key, bridge);
  return () => {
    Reflect.deleteProperty(globalThis, key);
  };
}
