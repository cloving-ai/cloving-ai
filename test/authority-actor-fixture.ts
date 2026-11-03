import { testMilliseconds } from "./test-timing.ts";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  openAuthority,
  type Authority,
  type AuthorityOptions,
  type Delivery,
  type DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import { recorded } from "./authority-fixture.ts";
import { manifest, queryDatabase } from "./authority-store-fixture.ts";

export { fastTiming, quickCleanupTiming } from "./authority-store-fixture.ts";

export async function openedAuthority(
  directory: string,
  options: AuthorityOptions = {},
): Promise<Authority> {
  const opening = await openAuthority(directory, options);
  assert.equal(opening.kind, "opened", JSON.stringify(opening));
  return opening.authority;
}

export function executePinned(
  authority: Authority,
  command: Readonly<Record<string, unknown>>,
): ReturnType<Authority["execute"]> {
  const pinned = ["admit-run", "decide-gate", "resume-run"].includes(
    String(command["kind"]),
  );
  return authority.execute(
    command,
    pinned ? { ...recorded, manifest } : recorded,
  );
}

export interface ExternalService {
  readonly sent: readonly DeliveryIntent[];
  readonly options: AuthorityOptions;
}

export interface GatedRun {
  readonly delivery: Delivery;
  readonly entered: Promise<void>;
  readonly release: () => void;
}

interface DeliveryCall {
  readonly runId: string;
  readonly count: number;
}

export function gatedDelivery(
  stuck: (call: DeliveryCall) => boolean,
): GatedRun {
  const sent: string[] = [];
  const entry = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  return {
    entered: entry.promise,
    release: () => {
      gate.resolve(undefined);
    },
    delivery: {
      deliver: async (intent) => {
        sent.push(intent.operationId);
        if (stuck({ runId: intent.runId, count: sent.length })) {
          entry.resolve(undefined);
          await gate.promise;
        }
        return { receipt: `receipt-${String(sent.length)}` };
      },
      reconcile: () => Promise.resolve({ kind: "absent" }),
    },
  };
}

export function externalService(): ExternalService {
  const sent: DeliveryIntent[] = [];
  return {
    sent,
    options: {
      delivery: {
        deliver: (intent) => {
          sent.push(intent);
          return Promise.resolve({ receipt: `receipt-${String(sent.length)}` });
        },
        reconcile: (intent) => {
          const index = sent.findIndex(
            (item) => item.operationId === intent.operationId,
          );
          return Promise.resolve(
            index === -1
              ? { kind: "absent" }
              : { kind: "accepted", receipt: `receipt-${String(index + 1)}` },
          );
        },
      },
    },
  };
}

export async function deliverUntil(
  authority: Authority,
  reached: () => Promise<boolean>,
): Promise<void> {
  const controller = new AbortController();
  const running = authority.deliver(controller.signal);
  try {
    for (let attempt = 0; !(await reached()); attempt += 1) {
      assert.ok(attempt < 250, "delivery did not settle");
      await delay(testMilliseconds(20));
    }
  } finally {
    controller.abort();
    await running;
  }
}

function readOutcome(authority: Authority): Promise<string> {
  return authority.state().then(
    (state) => `sequence ${String(state.sequence)}`,
    (error: unknown) => String(error),
  );
}

export async function readUntil(
  authority: Authority,
  reached: (outcome: string) => boolean,
): Promise<string> {
  let outcome = await readOutcome(authority);
  for (let attempt = 0; !reached(outcome) && attempt < 500; attempt += 1) {
    await delay(testMilliseconds(20));
    outcome = await readOutcome(authority);
  }
  return outcome;
}

export async function refusalWhileDelivering(
  authority: Authority,
): Promise<{ readonly read: string; readonly stopped: string }> {
  const controller = new AbortController();
  const delivering = authority.deliver(controller.signal).then(
    () => "stopped",
    (error: unknown) => String(error),
  );
  let read: string;
  try {
    read = await readUntil(
      authority,
      (outcome) => !outcome.startsWith("sequence "),
    );
  } finally {
    controller.abort();
  }
  return { read, stopped: await delivering };
}

export function storedCounts(
  directory: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    [
      "events",
      "commands",
      "runs",
      "definitions",
      "outbox",
      "deliveries",
      "solid_effects",
    ].map((table) => [
      table,
      queryDatabase(directory, `SELECT count(*) AS count FROM ${table}`),
    ]),
  );
}

export function actorState(directory: string): unknown {
  return queryDatabase(
    directory,
    "SELECT state FROM solid_instances WHERE actor_type = 'ClovingAuthority'",
  );
}
