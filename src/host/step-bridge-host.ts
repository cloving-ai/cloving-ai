import { setTimeout as delay } from "node:timers/promises";
import { getStepMetadata, getWorkflowMetadata } from "workflow";
import {
  stepBridgeKey,
  type ProtectedRequest,
  type ProtectedResult,
  type StepBridge,
} from "../step-bridge.ts";

export interface StepCall {
  readonly worldRunId: string;
  readonly stepId: string;
  readonly attempt: number;
}

export function sdkStepCall(): StepCall {
  const { stepId, attempt } = getStepMetadata();
  return { worldRunId: getWorkflowMetadata().workflowRunId, stepId, attempt };
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

export interface BridgeRequest extends ProtectedRequest {
  readonly runId: string;
  readonly commandId: string;
  readonly transport: string;
}

export interface BridgePorts {
  readonly call: () => StepCall;
  readonly runs: () => Promise<
    readonly { readonly runId: string; readonly receipt: string }[]
  >;
  readonly state: () => Promise<{
    readonly runs: Readonly<
      Record<string, { readonly status: string } | undefined>
    >;
  }>;
  readonly requestEffect: (request: BridgeRequest) => Promise<BridgeReply>;
  readonly operation: (
    operationId: string,
  ) => Promise<OperationRead | undefined>;
  readonly document: (digest: string) => Promise<string | undefined>;
}

const committed = ["accepted", "duplicate"];
const ended = ["failed", "stopped", "blocked", "cancelled"] as const;

function refusal(reply: BridgeReply): ProtectedResult | undefined {
  const { receipt, disposition } = reply;
  if (!committed.includes(receipt.kind))
    return { kind: "refused", reason: receipt.reason ?? receipt.kind };
  if (disposition?.disposition === "refused")
    return { kind: "refused", reason: disposition.reason ?? "refused" };
  return undefined;
}

async function settled(
  ports: BridgePorts,
  operationId: string,
): Promise<ProtectedResult> {
  for (;;) {
    const operation = await ports.operation(operationId);
    if (operation === undefined || operation.status === "refused")
      return { kind: "refused", reason: operation?.reason ?? "no-operation" };
    const { status, reason, receipt, result } = operation;
    const end = ended.find((kind) => kind === status);
    if (end !== undefined) return { kind: end, operationId, reason };
    if (status === "completed")
      return {
        kind: "completed",
        operationId,
        receipt,
        result:
          result === null ? null : ((await ports.document(result)) ?? null),
      };
    await delay(20);
  }
}

async function inWork(ports: BridgePorts, runId: string): Promise<void> {
  for (;;) {
    const status = (await ports.state()).runs[runId]?.status;
    if (status !== "queued") return;
    await delay(20);
  }
}

async function effect(
  ports: BridgePorts,
  request: ProtectedRequest,
): Promise<ProtectedResult> {
  const call = ports.call();
  const world = (await ports.runs()).find(
    (run) => run.receipt === call.worldRunId,
  );
  if (world === undefined)
    return { kind: "unavailable", reason: "unknown-world-run" };
  await inWork(ports, world.runId);
  const identity = `sdk:${call.stepId}:${String(call.attempt)}`.replace(
    /[^A-Za-z0-9._:/-]/g,
    "-",
  );
  const reply = await ports.requestEffect({
    ...request,
    runId: world.runId,
    commandId: identity,
    transport: identity,
  });
  const refused = refusal(reply);
  if (refused !== undefined) return refused;
  if (reply.operation === null)
    return { kind: "refused", reason: "no-operation" };
  return await settled(ports, reply.operation.operationId);
}

export function stepBridge(ports: BridgePorts): StepBridge {
  return { effect: (request) => effect(ports, request) };
}

export function registerStepBridge(bridge: StepBridge): () => void {
  const key = Symbol.for(stepBridgeKey);
  Reflect.set(globalThis, key, bridge);
  return () => {
    Reflect.deleteProperty(globalThis, key);
  };
}
