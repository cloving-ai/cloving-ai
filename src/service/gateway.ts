import type { Authority, StoreReceipt } from "../broker/actor/authority.ts";
import {
  invalidCommand,
  serializable,
  textList,
  unserializable,
} from "../broker/actor/authority-receipts.ts";
import { record } from "../protocol.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";
import type { Registry } from "./registry.ts";

export type Principal = "operator" | "worker" | "controller";

export type Command = Readonly<Record<string, unknown>>;

export interface Submission {
  readonly principal: Principal;
  readonly command: Command;
  readonly documents?: readonly string[];
  readonly epoch?: number;
}

export const workerCommandBound = 1_000;

export interface Gateway {
  readonly execute: (submission: Submission) => Promise<StoreReceipt>;
}

const permitted: Readonly<Record<Principal, readonly string[]>> = {
  operator: [
    "admit-run",
    "decide-gate",
    "pause-run",
    "resume-run",
    "cancel-run",
  ],
  worker: [
    "mark-started",
    "open-gate",
    "register-wait",
    "report-observation",
    "complete-run",
    "fail-run",
    "request-effect",
    "report-effect",
  ],
  controller: ["expire-gate", "expire-lease"],
};

const pinned = ["decide-gate", "resume-run"];

function denied(principal: Principal, subject: string): StoreReceipt {
  return {
    kind: "rejected",
    reason: "permission-denied",
    detail: `${principal} cannot send ${subject}`,
  };
}

interface Checked {
  readonly principal: Principal;
  readonly command: Command;
  readonly documents: readonly string[];
  readonly epoch?: number;
}

function checked(principal: Principal, copy: Command): Checked | undefined {
  const command = record(copy["command"]);
  const documents = textList(copy["documents"]);
  const epoch = copy["epoch"];
  if (command === undefined || documents === undefined) return undefined;
  if (epoch === undefined) return { principal, command, documents };
  if (typeof epoch !== "number") return undefined;
  return { principal, command, documents, epoch };
}

function busy(bound: number): StoreReceipt {
  return {
    kind: "rejected",
    reason: "service-busy",
    detail: `The service has ${String(bound)} worker commands in work. Send the command again with the same command ID.`,
  };
}

function refusal(
  submission: Checked,
  textBytes: number,
): StoreReceipt | undefined {
  const { principal, command } = submission;
  const kind = String(command["kind"]);
  if (!permitted[principal].includes(kind)) return denied(principal, kind);
  if (kind === "open-gate" && command["gateKind"] === undefined)
    return denied(principal, "an untyped gate");
  const long = submission.documents.some(
    (document) => Buffer.byteLength(document) > textBytes,
  );
  if (principal === "worker" && long)
    return {
      kind: "rejected",
      reason: "input-too-large",
      detail: `A text of a worker has at most ${String(textBytes)} bytes.`,
    };
  return undefined;
}

export function commandGateway(parts: {
  readonly authority: Authority;
  readonly registry: Registry;
  readonly clock: () => string;
  readonly textBytes: number;
  readonly pendingWorkerCommands?: number;
}): Gateway {
  const { authority, registry, clock, textBytes } = parts;
  const bound = parts.pendingWorkerCommands ?? workerCommandBound;
  let pending = 0;
  async function manifest(
    command: Command,
  ): Promise<ExecutionManifest | undefined> {
    const kind = String(command["kind"]);
    if (kind === "admit-run")
      return registry.byPin(String(command["workflow"]))?.manifest;
    if (!pinned.includes(kind)) return undefined;
    const runId = String(command["runId"]);
    const stored = await authority.queries.manifest(runId);
    if (stored?.bundleDigest !== undefined) return stored;
    const run = (await authority.state()).runs[runId];
    return registry.byPin(run?.workflow ?? "")?.manifest;
  }
  async function forwarded(submission: Checked): Promise<StoreReceipt> {
    const available = await manifest(submission.command);
    return authority.execute(submission.command, {
      recordedAt: clock(),
      ...(available === undefined ? {} : { manifest: available }),
      ...(submission.epoch === undefined ? {} : { epoch: submission.epoch }),
      documents: submission.documents,
    });
  }
  async function counted(submission: Checked): Promise<StoreReceipt> {
    if (pending >= bound) return busy(bound);
    pending += 1;
    try {
      return await forwarded(submission);
    } finally {
      pending -= 1;
    }
  }
  return {
    execute: async (given) => {
      const copy = serializable({
        command: given.command,
        documents: given.documents ?? [],
        ...(given.epoch === undefined ? {} : { epoch: given.epoch }),
      });
      if (copy === undefined) return unserializable;
      const submission = checked(given.principal, copy);
      if (submission === undefined) return invalidCommand;
      const refused = refusal(submission, textBytes);
      if (refused !== undefined) return refused;
      return submission.principal === "worker"
        ? counted(submission)
        : forwarded(submission);
    },
  };
}
