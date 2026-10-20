import assert from "node:assert/strict";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
} from "../src/broker/actor/authority.ts";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import type { SqlConnection } from "../src/storage/domain-rows.ts";
import {
  deliverUntil,
  executePinned,
  fastTiming,
} from "./authority-actor-fixture.ts";
import { storedGate } from "./authority-store-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { drop } from "./effect-stop-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

export async function stored<Result>(
  directory: string,
  read: (connection: SqlConnection) => Promise<Result>,
): Promise<Result> {
  const owned = await ownedDatabase(directory);
  assert.equal(owned.kind, "owned");
  try {
    return await owned.database.connection(read);
  } finally {
    await owned.database.close();
  }
}

export const start = storedGate[0] ?? {};

export interface Destination {
  readonly delivery: Delivery;
  readonly calls: string[];
}

export function unreachable(): Destination {
  const calls: string[] = [];
  return {
    calls,
    delivery: {
      reconcile: (intent) => {
        calls.push(`reconcile ${intent.runId}`);
        return Promise.reject(new Error("destination unreachable"));
      },
      deliver: (intent) => {
        calls.push(`deliver ${intent.runId}`);
        return Promise.reject(new Error("destination unreachable"));
      },
    },
  };
}

export function empty(): Destination {
  const calls: string[] = [];
  return {
    calls,
    delivery: {
      reconcile: (intent) => {
        calls.push(`reconcile ${intent.runId}`);
        return Promise.resolve({ kind: "absent" });
      },
      deliver: (intent) => {
        calls.push(`deliver ${intent.runId}`);
        return Promise.reject(new Error("no send expected"));
      },
    },
  };
}

const acceptance: AdapterOutcome = {
  kind: "accepted",
  receipt: "receipt-1",
  worker: "worker-1",
};

export function accepting(parts: {
  readonly stop?: AdapterOutcome;
  readonly failing: readonly string[];
}): Destination {
  const calls: string[] = [];
  const accepted = new Set<string>();
  const { stop, failing } = parts;
  const stopFunction: Delivery["stop"] = (intent) => {
    calls.push(`stop ${intent.runId}`);
    return Promise.resolve(stop ?? { kind: "unknown" });
  };
  return {
    calls,
    delivery: {
      reconcile: (intent) => {
        calls.push(`reconcile ${intent.runId}`);
        if (failing.includes(intent.runId))
          return Promise.reject(new Error("destination unreachable"));
        return Promise.resolve(
          accepted.has(intent.operationId) ? acceptance : { kind: "absent" },
        );
      },
      deliver: (intent) => {
        calls.push(`deliver ${intent.runId}`);
        accepted.add(intent.operationId);
        return Promise.resolve(acceptance);
      },
      ...(stop === undefined ? {} : { stop: stopFunction }),
    },
  };
}

export function unavailable(): Delivery {
  return {
    deliver: () => Promise.reject(new Error("no send expected")),
    get reconcile(): Delivery["reconcile"] {
      throw new Error("adapter unavailable");
    },
  };
}

export const bounded = {
  clock: (): string => noon,
  timing: fastTiming,
  effects: { deliveryAttempts: 1, stopLimit: 1 },
};

export const steady = {
  ...bounded,
  timing: {
    ...fastTiming,
    leaseMilliseconds: testMilliseconds(2_000),
    renewalMilliseconds: testMilliseconds(500),
    callTimeoutMilliseconds: testMilliseconds(10_000),
  },
};

export async function closedRows(
  authority: Authority,
  rows: number,
): Promise<number> {
  return (await authority.operations()).filter(
    (record) =>
      record.deliveries.length === rows &&
      record.deliveries.every((item) => item.outcome !== null),
  ).length;
}

export async function droppedAtTheBound(
  authority: Authority,
  group: { readonly runs: readonly string[]; readonly bounded: number },
): Promise<void> {
  const { runs } = group;
  for (const runId of runs)
    await executePinned(authority, {
      ...start,
      runId,
      commandId: `c-admit-${runId}`,
    });
  await deliverUntil(
    authority,
    async () => (await closedRows(authority, 1)) === runs.length,
  );
  for (const runId of runs)
    await authority.execute(
      { ...drop, runId, commandId: `c-drop-${runId}`, expectedRevision: 1 },
      { recordedAt: noon },
    );
  await deliverUntil(
    authority,
    async () => (await closedRows(authority, 2)) === group.bounded,
  );
}
