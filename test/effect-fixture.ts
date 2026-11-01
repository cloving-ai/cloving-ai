import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type {
  Authority,
  Delivery,
  StoreReceipt,
} from "../src/broker/actor/authority.ts";
import { operationIdentity } from "../src/operation-identity.ts";
import {
  manifest,
  queryDatabase,
  storedGate,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";

export const noon = "2026-10-10T12:00:00.000Z";
export const later = "2026-10-10T12:10:00.000Z";

export const effectTables = [
  "run_budgets",
  "operations",
  "leases",
  "effect_evidence",
  "stopped_operations",
  "dispatch_attempts",
];

export const startOperation =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

export function tableRows(
  directory: string,
  tables: readonly string[],
): unknown {
  return tables.map((table) =>
    queryDatabase(directory, `SELECT * FROM ${table} ORDER BY rowid`),
  );
}

export const versionThree = `
DROP INDEX events_run_type_sequence;
DROP INDEX events_spend_window;
DROP TABLE command_waits;
DROP TABLE dispatch_attempts;
DROP TABLE stopped_operations;
DROP TABLE effect_evidence;
DROP TABLE leases;
DROP TABLE operations;
DROP TABLE run_budgets;
DELETE FROM schema_migrations WHERE version >= 4;
PRAGMA user_version = 3;
`;

export interface Clock {
  now: string;
}

type Fields = Readonly<Record<string, unknown>>;

export type Send = (
  command: Fields,
  documents?: readonly string[],
) => Promise<StoreReceipt>;

const pinned = ["admit-run", "decide-gate", "resume-run"];

export function sender(authority: Authority, clock: Clock): Send {
  return (command, documents = []) =>
    authority.execute(command, {
      recordedAt: clock.now,
      epoch: authority.epoch,
      documents,
      ...(pinned.includes(String(command["kind"])) ? { manifest } : {}),
    });
}

export function inputDigest(effect: {
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
}): string {
  const text = JSON.stringify([
    "cloving-effect-input",
    1,
    effect.capability,
    effect.method,
    effect.target,
    effect.payload,
  ]);
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function operationOf(
  runId: string,
  visit: { readonly round: number; readonly key?: string },
): string {
  const identity = operationIdentity({
    run: runId,
    phase: "work",
    operation: "effect",
    ...visit,
  });
  if (identity.kind !== "valid") throw new Error(identity.reason);
  return identity.value;
}

export interface RequestParts {
  readonly commandId: string;
  readonly round: number;
  readonly runId?: string;
  readonly payload?: string;
  readonly resource?: string;
  readonly units?: number;
  readonly transport?: string;
}

export interface Request {
  readonly operationId: string;
  readonly inputDigest: string;
  readonly command: Fields;
  readonly documents: readonly string[];
}

export function effectRequest(parts: RequestParts): Request {
  const runId = parts.runId ?? "run-1";
  const payload = parts.payload ?? "build the package";
  const effect = {
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: digestOf(payload),
  };
  const operationId = operationOf(runId, { round: parts.round });
  const digest = inputDigest(effect);
  return {
    operationId,
    inputDigest: digest,
    documents: [payload],
    command: {
      kind: "request-effect",
      runId,
      commandId: parts.commandId,
      operationId,
      ...effect,
      inputDigest: digest,
      units: parts.units ?? 1,
      recoveryLimit: 3,
      ...(parts.resource === undefined ? {} : { resource: parts.resource }),
      ...(parts.transport === undefined ? {} : { transport: parts.transport }),
    },
  };
}

export interface LeaseExpiry {
  readonly kind: "expire-lease";
  readonly commandId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly leaseGeneration: number;
}

export function leaseExpiry(request: Request, generation: number): LeaseExpiry {
  const digest = createHash("sha256").update(request.operationId).digest("hex");
  return {
    kind: "expire-lease",
    commandId: `expire-lease:${digest}:${String(generation)}`,
    runId: String(request.command["runId"]),
    operationId: request.operationId,
    leaseGeneration: generation,
  };
}

export function effectReport(
  request: Request,
  report: {
    readonly commandId: string;
    readonly leaseGeneration: number;
    readonly worker: string;
    readonly result: string;
  },
): { readonly command: Fields; readonly documents: readonly string[] } {
  return {
    documents: [report.result],
    command: {
      kind: "report-effect",
      runId: "run-1",
      commandId: report.commandId,
      operationId: request.operationId,
      inputDigest: request.inputDigest,
      leaseGeneration: report.leaseGeneration,
      worker: report.worker,
      outcome: "completed",
      result: digestOf(report.result),
    },
  };
}

export async function runningRun(
  send: Send,
  budget: { readonly effectLimit: number; readonly runId?: string },
): Promise<void> {
  const runId = budget.runId ?? "run-1";
  const admitted = await send({
    ...storedGate[0],
    runId,
    commandId: `c-admitted-${runId}`,
    effectLimit: budget.effectLimit,
    capabilities: JSON.stringify([...manifest.capabilities].sort()),
  });
  assert.equal(admitted.kind, "accepted", JSON.stringify(admitted));
  const started = await send({
    kind: "mark-started",
    commandId: `c-started-${runId}`,
    runId,
    expectedRevision: 1,
  });
  assert.equal(started.kind, "accepted", JSON.stringify(started));
}

export interface Destination {
  readonly delivery: Delivery;
  readonly effects: string[];
  readonly calls: string[];
  readonly intents: unknown[];
}

export function fakeDestination(
  fault: { readonly lostReplies: number } = { lostReplies: 0 },
): Destination {
  const effects: string[] = [];
  const calls: string[] = [];
  const intents: unknown[] = [];
  let lost = fault.lostReplies;
  const accepted = (intent: {
    readonly operationId: string;
    readonly leaseGeneration?: number;
  }): {
    readonly kind: "accepted";
    readonly receipt: string;
    readonly worker: string;
  } => ({
    kind: "accepted",
    receipt: `receipt-${String(effects.indexOf(intent.operationId) + 1)}`,
    worker: `worker-${String(intent.leaseGeneration ?? 0)}`,
  });
  return {
    effects,
    calls,
    intents,
    delivery: {
      deliver: (intent) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ receipt: "receipt-run" });
        calls.push(`deliver ${intent.operationId}`);
        intents.push(intent);
        effects.push(intent.operationId);
        if (lost === 0) return Promise.resolve(accepted(intent));
        lost -= 1;
        return Promise.reject(new Error("the reply is lost"));
      },
      reconcile: (intent) => {
        if (intent.kind !== "protected-effect")
          return Promise.resolve({ kind: "absent" });
        calls.push(`reconcile ${intent.operationId}`);
        return Promise.resolve(
          effects.includes(intent.operationId)
            ? accepted(intent)
            : { kind: "absent" },
        );
      },
    },
  };
}

function lines(file: string): readonly string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function destinationRecords(file: string): readonly string[] {
  return lines(file);
}

export function fileDestination(
  file: string,
  behavior: { readonly afterSend?: () => Promise<void> } = {},
): Delivery {
  const accepted = (intent: {
    readonly operationId: string;
    readonly leaseGeneration?: number;
  }): {
    readonly kind: "accepted";
    readonly receipt: string;
    readonly worker: string;
  } => ({
    kind: "accepted",
    receipt: `receipt-${String(lines(file).indexOf(intent.operationId) + 1)}`,
    worker: `worker-${String(intent.leaseGeneration ?? 0)}`,
  });
  return {
    deliver: async (intent) => {
      if (intent.kind !== "protected-effect") return { receipt: "receipt-run" };
      appendFileSync(file, `${intent.operationId}\n`);
      await behavior.afterSend?.();
      return accepted(intent);
    },
    reconcile: (intent) =>
      Promise.resolve(
        intent.kind === "protected-effect" &&
          lines(file).includes(intent.operationId)
          ? accepted(intent)
          : { kind: "absent" },
      ),
  };
}
