import assert from "node:assert/strict";
import {
  openedAuthority,
  deliverUntil,
  quickCleanupTiming,
} from "./authority-actor-fixture.ts";
import { temporaryDirectory } from "./authority-store-fixture.ts";
import { context, opening, startWaitRun } from "./command-wait-fixture.ts";
import { key, checkRequest, start } from "./command-wait-check-fixture.ts";
import type {
  Authority,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";

export async function commandWaitScene() {
  const directory = await temporaryDirectory();
  const clock = { now: start, output: '{"ready":false}' };
  const calls: DeliveryIntent[] = [];
  const options = {
    timing: quickCleanupTiming,
    effects: { capacity: 1 },
    clock: () => new Date(clock.now).toISOString(),
    delivery: {
      reconcile: () => Promise.resolve({ kind: "absent" as const }),
      deliver: (intent: DeliveryIntent) => {
        calls.push(intent);
        return Promise.resolve({
          kind: "completed" as const,
          worker: "command",
          receipt: "receipt",
          result: clock.output,
        });
      },
    },
  };
  const store = await openedAuthority(directory, options);
  await startWaitRun(store, { runId: "run-1" });
  assert.equal((await store.execute(opening, context)).kind, "accepted");
  return {
    directory,
    clock,
    calls,
    store,
    reopen: () => openedAuthority(directory, options),
  };
}

export async function storedCheck(
  store: Authority,
  check: { readonly commandId: string; readonly now: number },
): Promise<void> {
  assert.equal(
    (
      await store.execute(
        { ...checkRequest, commandId: check.commandId },
        {
          ...context,
          epoch: store.epoch,
          recordedAt: new Date(check.now).toISOString(),
        },
      )
    ).kind,
    "accepted",
  );
  await deliverUntil(
    store,
    async () =>
      (await store.state()).commandWaits?.[key]?.lastCheckSettledAt ===
      check.now,
  );
}
