import assert from "node:assert/strict";
import type {
  AdapterOutcome,
  Authority,
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import { temporaryDirectory } from "./authority-store-fixture.ts";
import {
  effectRequest,
  noon,
  runningRun,
  sender,
  type Request,
  type Send,
} from "./effect-fixture.ts";

export type Reply = (intent: DeliveryIntent) => Promise<AdapterOutcome>;

export interface Stopper {
  readonly delivery: Delivery;
  readonly calls: string[];
  readonly accepted: Set<string>;
}

const absent: AdapterOutcome = { kind: "absent" };

export function stopper(stop: Reply | undefined): Stopper {
  const calls: string[] = [];
  const accepted = new Set<string>();
  const position = (intent: DeliveryIntent): string =>
    String(intent.operationId.match(/,(\d+),/)?.[1]);
  const acceptance = (intent: DeliveryIntent): AdapterOutcome => ({
    kind: "accepted",
    receipt: `receipt-${position(intent)}`,
    worker: "worker-1",
  });
  const named = (name: string, intent: DeliveryIntent): string =>
    `${name} ${intent.kind} ${position(intent)}`;
  return {
    calls,
    accepted,
    delivery: {
      reconcile: (intent) => {
        calls.push(named("reconcile", intent));
        return Promise.resolve(
          accepted.has(intent.operationId) ? acceptance(intent) : absent,
        );
      },
      deliver: (intent) => {
        calls.push(named("deliver", intent));
        accepted.add(intent.operationId);
        return Promise.resolve(acceptance(intent));
      },
      ...(stop === undefined
        ? {}
        : {
            stop: (intent: DeliveryIntent): Promise<AdapterOutcome> => {
              calls.push(named("stop", intent));
              return stop(intent);
            },
          }),
    },
  };
}

export interface Scene {
  readonly authority: Authority;
  readonly adapter: Stopper;
  readonly directory: string;
  readonly send: Send;
}

export async function scene(
  stop: Reply | undefined,
  directory?: string,
): Promise<Scene> {
  const adapter = stopper(stop);
  const folder = directory ?? (await temporaryDirectory());
  const authority = await openedAuthority(folder, {
    delivery: adapter.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  return {
    authority,
    adapter,
    directory: folder,
    send: sender(authority, { now: noon }),
  };
}

export const drop = {
  kind: "cancel-run",
  commandId: "c-drop",
  runId: "run-1",
  expectedRevision: 2,
};

export async function runningEffects(
  started: Scene,
  rounds: readonly number[],
): Promise<readonly Request[]> {
  await runningRun(started.send, { effectLimit: 8 });
  const requests = rounds.map((round) =>
    effectRequest({ commandId: `c-${String(round)}`, round }),
  );
  for (const request of requests)
    await started.send(request.command, request.documents);
  await deliverUntil(
    started.authority,
    async () => (await started.authority.eligibleIntents()).length === 0,
  );
  return requests;
}

export async function statuses(
  authority: Authority,
  requests: readonly Request[],
): Promise<readonly unknown[]> {
  const views = [];
  for (const request of requests) {
    const view = await authority.effects.operation(request.operationId);
    views.push([view?.status, view?.receipt]);
  }
  return views;
}

export function stops(calls: readonly string[]): readonly string[] {
  return calls.filter((call) => call.startsWith("stop"));
}

export async function quiet(authority: Authority): Promise<void> {
  let rounds = 0;
  await deliverUntil(authority, () => {
    rounds += 1;
    return Promise.resolve(rounds > 20);
  });
}

export function finalAt(
  authority: Authority,
  expected: { readonly request: Request; readonly status: string },
): Promise<void> {
  return deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(expected.request.operationId))
        ?.status === expected.status,
  );
}

export const stopped: Reply = () => Promise.resolve({ kind: "stopped" });

export interface Expiring {
  readonly authority: Authority;
  readonly adapter: Stopper;
  readonly directory: string;
  readonly send: Send;
  readonly clock: { now: string };
  readonly request: Request;
  readonly options: {
    readonly clock: () => string;
    readonly timing: typeof fastTiming;
    readonly effects: { readonly capacity: number };
  };
}

export async function droppedWithNoStop(
  wrap: (delivery: Delivery) => Delivery,
): Promise<Expiring> {
  const directory = await temporaryDirectory();
  const adapter = stopper(undefined);
  const clock = { now: noon };
  const options = {
    clock: (): string => clock.now,
    timing: fastTiming,
    effects: { capacity: 1 },
  };
  const authority = await openedAuthority(directory, {
    ...options,
    delivery: wrap(adapter.delivery),
  });
  const send = sender(authority, clock);
  await runningRun(send, { effectLimit: 8 });
  const request = effectRequest({ commandId: "c-1", round: 1 });
  await send(request.command, request.documents);
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(request.operationId))?.status ===
      "running",
  );
  assert.equal((await send(drop)).kind, "accepted");
  await quiet(authority);
  return { authority, adapter, directory, send, clock, request, options };
}
