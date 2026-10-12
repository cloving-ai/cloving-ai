import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { Database } from "solid-objects";
import { trackedDelivery } from "../src/broker/actor/authority-release.ts";
import { authoritySession } from "../src/broker/actor/authority-session.ts";

function rejecting(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message));
}

await test("CLV-049 a close with a rejected runtime close also closes the database and reports the first error", async () => {
  const closed: string[] = [];
  const closing = (name: string): (() => Promise<never>) => {
    const reject = rejecting(`${name} close failed`);
    return () => {
      closed.push(name);
      return reject();
    };
  };
  const delivery = trackedDelivery({
    runtime: { registerEffect: () => undefined, close: closing("runtime") },
    database: { close: closing("database") },
    handle: () => Promise.resolve({}),
    shutdownMilliseconds: 100,
  });
  await assert.rejects(delivery.stop(), /^Error: runtime close failed$/);
  assert.deepEqual(closed, ["runtime", "database"]);
});

const unusable: Database = {
  family: "sqlite",
  schemaIdentity: "test",
  connection: rejecting("no connection"),
  transaction: rejecting("no transaction"),
  close: () => Promise.resolve(),
};

const parts = {
  database: unusable,
  reader: unusable,
  execute: (): Promise<unknown> => Promise.resolve({}),
  run: (): Promise<void> => Promise.resolve(),
  stop: (): Promise<void> => Promise.resolve(),
  handlersSettled: (): Promise<boolean> => Promise.resolve(true),
  deliveryConfigured: true,
  epoch: 1,
  unhealthy: (): string | undefined => undefined,
  halted: new AbortController().signal,
  condition: (): Promise<string | undefined> => Promise.resolve(undefined),
  watchMilliseconds: 1_000,
  stopLimit: 3,
  recoveryLimit: 3,
};

await test("CLV-049 a background close of a fail-closed path that rejects causes no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  const stops: string[] = [];
  const authority = authoritySession({
    ...parts,
    stop: () => {
      stops.push("stop");
      return Promise.reject(new Error("stop failed"));
    },
    unhealthy: () => "activation lost",
    condition: () => Promise.resolve("activation lost"),
  });
  const receipt = await authority.execute(
    {
      kind: "pause-run",
      commandId: "c-1",
      runId: "run-1",
      expectedRevision: 1,
    },
    { recordedAt: "2026-10-10T12:00:00.000Z" },
  );
  assert.deepEqual(receipt, {
    kind: "failed",
    reason: "storage-unavailable",
    detail: "closed after activation lost",
  });
  await turn();
  await turn();
  process.off("unhandledRejection", record);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(stops, ["stop"]);
  await assert.rejects(authority.close(), /^Error: stop failed$/);
});

await test("CLV-049 a delivery run that waits for the handlers of an earlier run does not start after a close", async () => {
  const settled = Promise.withResolvers<boolean>();
  const runs: string[] = [];
  const authority = authoritySession({
    ...parts,
    handlersSettled: () => settled.promise,
    run: () => {
      runs.push("run");
      return Promise.resolve();
    },
  });
  const delivering = authority.deliver(new AbortController().signal).then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  await assert.rejects(
    authority.deliver(new AbortController().signal),
    /^Error: delivery-already-running$/,
  );
  await authority.close();
  settled.resolve(true);
  assert.equal(await delivering, "Error: authority-unavailable: closed");
  assert.deepEqual(runs, []);
});
