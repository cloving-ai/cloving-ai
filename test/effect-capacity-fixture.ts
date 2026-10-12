import assert from "node:assert/strict";
import type {
  Authority,
  AuthorityOptions,
} from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import { temporaryDirectory } from "./authority-store-fixture.ts";
import {
  effectReport,
  effectRequest,
  fakeDestination,
  noon,
  runningRun,
  sender,
  type Destination,
  type Request,
  type Send,
} from "./effect-fixture.ts";

export interface Scene {
  readonly authority: Authority;
  readonly destination: Destination;
  readonly directory: string;
  readonly send: Send;
}

export async function reopened(
  earlier: Pick<Scene, "directory" | "destination">,
  effects: AuthorityOptions["effects"],
): Promise<Scene> {
  const authority = await openedAuthority(earlier.directory, {
    delivery: earlier.destination.delivery,
    clock: () => noon,
    timing: fastTiming,
    ...(effects === undefined ? {} : { effects }),
  });
  return { ...earlier, authority, send: sender(authority, { now: noon }) };
}

export async function scene(
  capacity: number,
  runs: readonly string[],
): Promise<Scene> {
  const started = await reopened(
    { directory: await temporaryDirectory(), destination: fakeDestination() },
    { capacity },
  );
  for (const runId of runs)
    await runningRun(started.send, { effectLimit: 5, runId });
  return started;
}

export function requestOf(
  runId: string,
  parts: { readonly round: number; readonly resource?: string },
): Request {
  return effectRequest({
    commandId: `c-${runId}-${String(parts.round)}`,
    runId,
    ...parts,
  });
}

export async function statuses(
  authority: Authority,
  requests: readonly Request[],
): Promise<readonly unknown[]> {
  const views = [];
  for (const request of requests) {
    const view = await authority.effects.operation(request.operationId);
    views.push([view?.status, view?.reason, view?.leaseGeneration]);
  }
  return views;
}

export function settled(authority: Authority): Promise<void> {
  return deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
}

export async function completed(
  started: Scene,
  request: Request,
): Promise<void> {
  const view = await started.authority.effects.operation(request.operationId);
  const report = effectReport(request, {
    commandId: `c-report-${String(view?.requestedSequence)}`,
    leaseGeneration: view?.leaseGeneration ?? 0,
    worker: view?.worker ?? "",
    result: "the result",
  });
  const receipt = await started.send(
    { ...report.command, runId: view?.runId },
    report.documents,
  );
  assert.equal(Reflect.get(receipt, "disposition"), "applied");
}
