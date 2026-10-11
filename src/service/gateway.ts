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
}

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
  ],
  controller: ["expire-gate"],
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
}

function checked(principal: Principal, copy: Command): Checked | undefined {
  const command = record(copy["command"]);
  const documents = textList(copy["documents"]);
  if (command === undefined || documents === undefined) return undefined;
  return { principal, command, documents };
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
}): Gateway {
  const { authority, registry, clock, textBytes } = parts;
  async function manifest(
    command: Command,
  ): Promise<ExecutionManifest | undefined> {
    const kind = String(command["kind"]);
    if (kind === "admit-run")
      return registry.byPin(String(command["workflow"]))?.manifest;
    if (!pinned.includes(kind)) return undefined;
    const run = (await authority.state()).runs[String(command["runId"])];
    return registry.byPin(run?.workflow ?? "")?.manifest;
  }
  return {
    execute: async (given) => {
      const copy = serializable({
        command: given.command,
        documents: given.documents ?? [],
      });
      if (copy === undefined) return unserializable;
      const submission = checked(given.principal, copy);
      if (submission === undefined) return invalidCommand;
      const refused = refusal(submission, textBytes);
      if (refused !== undefined) return refused;
      const available = await manifest(submission.command);
      return authority.execute(submission.command, {
        recordedAt: clock(),
        ...(available === undefined ? {} : { manifest: available }),
        documents: submission.documents,
      });
    },
  };
}
