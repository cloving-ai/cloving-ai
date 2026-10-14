import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterOutcome,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";

export interface WorkerReport {
  readonly runId: string;
  readonly commandId: string;
  readonly operationId: string;
  readonly inputDigest: string;
  readonly leaseGeneration: number;
  readonly worker: string;
  readonly outcome: "completed" | "failed" | "stopped";
  readonly result?: string;
  readonly reason?: string;
}

export interface Recorded {
  readonly outcome: WorkerReport["outcome"];
  readonly result?: string;
  readonly reason?: string;
  readonly endedAt: string;
}

export interface Located {
  readonly key: string;
  readonly folder: string;
}

export interface Identity {
  readonly receipt: string;
  readonly worker: string;
}

export function operationKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function located(journal: string, operationId: string): Located {
  const key = operationKey(operationId);
  return { key, folder: join(journal, key) };
}

export async function readRecord(
  folder: string,
  name: string,
): Promise<unknown> {
  const text = await readFile(join(folder, name), "utf8").catch(
    () => undefined,
  );
  const value: unknown = text === undefined ? undefined : JSON.parse(text);
  return value;
}

export async function writeRecord(
  folder: string,
  record: { readonly name: string; readonly value: unknown },
): Promise<void> {
  const path = join(folder, record.name);
  await mkdir(folder, { recursive: true });
  await writeFile(`${path}.staged`, JSON.stringify(record.value, null, 2));
  await rename(`${path}.staged`, path);
}

export function replied(identity: Identity, recorded: unknown): AdapterOutcome {
  const field = (name: string): unknown => Reflect.get(Object(recorded), name);
  if (field("outcome") === "completed")
    return { kind: "completed", ...identity, result: String(field("result")) };
  if (field("outcome") === "stopped") return { kind: "stopped", ...identity };
  const result = field("result");
  return {
    kind: "failed",
    ...identity,
    reason: String(field("reason")),
    ...(typeof result === "string" ? { result } : {}),
  };
}

export function interrupted(reason: string): Recorded {
  return { outcome: "failed", reason, endedAt: new Date().toISOString() };
}

export function reportOf(
  operation: {
    readonly intent: ProtectedIntent;
    readonly commandId: string;
    readonly worker: string;
  },
  recorded: Recorded,
): WorkerReport {
  const { intent, commandId, worker } = operation;
  const { outcome, result, reason } = recorded;
  return {
    runId: intent.runId,
    commandId,
    operationId: intent.operationId,
    inputDigest: intent.inputDigest,
    leaseGeneration: intent.leaseGeneration,
    worker,
    outcome,
    ...(result === undefined ? {} : { result }),
    ...(reason === undefined ? {} : { reason }),
  };
}
