import type {
  Authority,
  OperationView,
  StoreReceipt,
  StoredDisposition,
} from "../broker/actor/authority.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import { effectInputDigest } from "../broker/effect-restore.ts";
import { operationIdentity } from "../operation-identity.ts";
import type { Command, Gateway } from "./gateway.ts";

interface Identified {
  readonly runId: string;
  readonly commandId: string;
}

interface Revised extends Identified {
  readonly expectedRevision: number;
}

export interface GateOpening extends Revised {
  readonly gateId: string;
  readonly kind: "question" | "approval";
  readonly prompt: string;
  readonly subject: string;
  readonly expiresAt?: string;
}

export interface WaitRegistration extends Identified {
  readonly gateId: string;
}

export interface ObservationReport extends Identified {
  readonly condition: string;
  readonly reason: string;
  readonly evidence?: string;
  readonly retryAt?: string;
  readonly operationId?: string;
  readonly attempt?: number;
  readonly limit?: number;
}

export interface EffectScope {
  readonly phase: string;
  readonly operation: string;
  readonly round: number;
  readonly key?: string;
  readonly stage?: {
    readonly id: string;
    readonly visit: string;
    readonly branch: string;
  };
}

export interface EffectRequest extends Identified {
  readonly scope: EffectScope;
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
  readonly units: number;
  readonly resource?: string;
  readonly transport?: string;
  readonly source?: string;
  readonly sourceGeneration?: number;
  readonly epoch?: number;
}

export interface EffectReport extends Identified {
  readonly operationId: string;
  readonly inputDigest: string;
  readonly leaseGeneration: number;
  readonly worker: string;
  readonly outcome: "completed" | "failed" | "stopped";
  readonly result?: string;
  readonly reason?: string;
  readonly evidence?: string;
  readonly epoch?: number;
}

export interface EffectReply {
  readonly receipt: StoreReceipt;
  readonly disposition: StoredDisposition | null;
  readonly operation: OperationView | null;
}

export interface WorkerPort {
  readonly submit: (
    command: Command,
    documents?: readonly string[],
  ) => Promise<StoreReceipt>;
  readonly started: (run: Revised) => Promise<StoreReceipt>;
  readonly openGate: (opening: GateOpening) => Promise<StoreReceipt>;
  readonly registerWait: (wait: WaitRegistration) => Promise<StoreReceipt>;
  readonly observe: (report: ObservationReport) => Promise<StoreReceipt>;
  readonly completed: (run: Revised) => Promise<StoreReceipt>;
  readonly failed: (run: Revised) => Promise<StoreReceipt>;
  readonly requestEffect: (request: EffectRequest) => Promise<EffectReply>;
  readonly reportEffect: (report: EffectReport) => Promise<EffectReply>;
}

function reference(text: unknown): string | null {
  return typeof text === "string" ? documentDigest(text) : null;
}

function sequenceOf(receipt: StoreReceipt): number | undefined {
  const committed = receipt.kind === "accepted" || receipt.kind === "duplicate";
  return committed ? receipt.sequence : undefined;
}

interface Effects {
  readonly requestEffect: WorkerPort["requestEffect"];
  readonly reportEffect: WorkerPort["reportEffect"];
}

interface Parts {
  readonly gateway: Gateway;
  readonly authority: Authority;
}

async function stored(
  authority: Authority,
  answer: { readonly receipt: StoreReceipt; readonly operationId: string },
): Promise<EffectReply> {
  const { receipt, operationId } = answer;
  if (receipt.kind === "failed")
    return { receipt, disposition: null, operation: null };
  const sequence = sequenceOf(receipt);
  const disposition =
    sequence === undefined
      ? undefined
      : await authority.effects.disposition(sequence);
  return {
    receipt,
    disposition: disposition ?? null,
    operation: (await authority.effects.operation(operationId)) ?? null,
  };
}

function unanswered(reason: string): EffectReply {
  return {
    receipt: { kind: "rejected", reason },
    disposition: null,
    operation: null,
  };
}

function effectPort(parts: Parts): Effects {
  const { gateway, authority } = parts;
  return {
    requestEffect: async (request) => {
      const { scope, payload, epoch, ...rest } = request;
      const identity = operationIdentity({ ...scope, run: request.runId });
      if (identity.kind !== "valid") return unanswered(identity.reason);
      const operationId = identity.value;
      const digest = documentDigest(payload);
      const receipt = await gateway.execute({
        principal: "worker",
        command: {
          kind: "request-effect",
          ...rest,
          operationId,
          payload: digest,
          inputDigest: effectInputDigest({
            capability: request.capability,
            method: request.method,
            target: request.target,
            payload: digest,
          }),
          recoveryLimit: authority.recoveryLimit,
        },
        documents: [payload],
        epoch: epoch ?? authority.epoch,
      });
      return stored(authority, { receipt, operationId });
    },
    reportEffect: async (report) => {
      const { result, epoch, ...rest } = report;
      const receipt = await gateway.execute({
        principal: "worker",
        command: {
          kind: "report-effect",
          ...rest,
          ...(result === undefined ? {} : { result: documentDigest(result) }),
        },
        documents: result === undefined ? [] : [result],
        epoch: epoch ?? authority.epoch,
      });
      return stored(authority, {
        receipt,
        operationId: report.operationId,
      });
    },
  };
}

export function workerPort(parts: Parts): WorkerPort {
  const { gateway } = parts;
  const submit = (
    command: Command,
    documents?: readonly string[],
  ): Promise<StoreReceipt> =>
    gateway.execute({
      principal: "worker",
      command,
      ...(documents === undefined ? {} : { documents }),
    });
  return {
    submit,
    started: (run) => submit({ kind: "mark-started", ...run }),
    openGate: (opening) => {
      const { kind, prompt, ...rest } = opening;
      return submit(
        {
          kind: "open-gate",
          ...rest,
          gateKind: kind,
          prompt: reference(prompt),
        },
        [prompt],
      );
    },
    registerWait: (wait) => submit({ kind: "register-wait", ...wait }),
    observe: (report) => submit({ kind: "report-observation", ...report }),
    completed: (run) => submit({ kind: "complete-run", ...run }),
    failed: (run) => submit({ kind: "fail-run", ...run }),
    ...effectPort(parts),
  };
}
