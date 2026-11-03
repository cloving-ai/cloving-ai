import { testMilliseconds } from "./test-timing.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  setImmediate as turn,
  setTimeout as delay,
} from "node:timers/promises";
import type { Database, Logger } from "solid-objects";
import { trackedDelivery } from "../src/broker/actor/authority-release.ts";
import {
  authoritySession,
  type Authority,
} from "../src/broker/actor/authority-session.ts";

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
    shutdownMilliseconds: testMilliseconds(100),
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

interface Recorded {
  readonly logger: Logger;
  readonly lines: (readonly [string, unknown])[];
}

function recorder(): Recorded {
  const lines: (readonly [string, unknown])[] = [];
  const level =
    (name: string) =>
    (entry: unknown): void => {
      lines.push([name, entry]);
    };
  return {
    lines,
    logger: {
      debug: level("debug"),
      info: level("info"),
      warn: level("warn"),
      error: level("error"),
    },
  };
}

const parts = {
  database: unusable,
  reader: unusable,
  execute: (): Promise<unknown> => Promise.resolve({}),
  run: (): Promise<void> => Promise.resolve(),
  stop: (): Promise<void> => Promise.resolve(),
  handlersSettled: (): Promise<boolean> => Promise.resolve(true),
  deliveryConfigured: true,
  epoch: 1,
  condition: (): Promise<string | undefined> => Promise.resolve(undefined),
  logger: recorder().logger,
  watchMilliseconds: testMilliseconds(1_000),
  stopLimit: 3,
  recoveryLimit: 3,
  subscribe: (): (() => void) => () => undefined,
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
    execute: () => Promise.reject(new Error("broken")),
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
    reason: "authority-unavailable",
    detail: "Error: broken",
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

async function until(reached: () => boolean): Promise<void> {
  const limit = performance.now() + testMilliseconds(2_000);
  while (!reached() && performance.now() < limit)
    await delay(testMilliseconds(10));
}

const context = { recordedAt: "2026-11-03T12:00:00.000Z" };

function pause(commandId: string): unknown {
  return { kind: "pause-run", commandId, runId: "run-1", expectedRevision: 1 };
}

const accepted = { kind: "accepted", sequence: 1, intents: [] };

function refusal(detail: string): unknown {
  return { kind: "failed", reason: "authority-unavailable", detail };
}

function recordingSession(condition: () => Promise<string | undefined>): {
  readonly authority: Authority;
  readonly calls: readonly string[];
} {
  const calls: string[] = [];
  const authority = authoritySession({
    ...parts,
    execute: () => {
      calls.push("execute");
      return Promise.resolve(accepted);
    },
    stop: () => {
      calls.push("stop");
      return Promise.resolve();
    },
    condition,
  });
  return { authority, calls };
}

function lookups(
  results: (Error | undefined)[],
): () => Promise<string | undefined> {
  return () => {
    const failure = results.shift();
    return failure === undefined
      ? Promise.resolve(undefined)
      : Promise.reject(failure);
  };
}

await test("CLV-279 a session refuses commands and reads while the watchdog reports a condition, and accepts them again when the condition clears, with no restart", async () => {
  const health: { condition: string | undefined } = {
    condition: "stranded message m-1",
  };
  const { authority, calls } = recordingSession(() =>
    Promise.resolve(health.condition),
  );
  assert.deepEqual(
    await authority.execute(pause("c-1"), context),
    refusal("stranded message m-1"),
  );
  await assert.rejects(
    authority.events(),
    /^Error: authority-unavailable: stranded message m-1$/,
  );
  health.condition = undefined;
  assert.deepEqual(await authority.execute(pause("c-2"), context), accepted);
  await assert.rejects(authority.events(), /^Error: no connection$/);
  assert.deepEqual(calls, ["execute"]);
});

await test("CLV-279 a session logs one line when it becomes unhealthy and one line when it recovers", async () => {
  const health: { condition: string | undefined } = { condition: undefined };
  const recorded = recorder();
  const authority = authoritySession({
    ...parts,
    execute: () => Promise.resolve(accepted),
    condition: () => Promise.resolve(health.condition),
    logger: recorded.logger,
  });
  const commands = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1)
      await authority.execute(pause(`c-${String(index)}`), context);
  };
  await commands(2);
  health.condition = "stranded message m-1";
  await commands(2);
  health.condition = "dead-lettered message m-2: cause";
  await commands(2);
  health.condition = undefined;
  await commands(2);
  assert.deepEqual(recorded.lines, [
    [
      "warn",
      { event: "authority-unhealthy", condition: "stranded message m-1" },
    ],
    [
      "info",
      {
        event: "authority-recovered",
        condition: "dead-lettered message m-2: cause",
      },
    ],
  ]);
});

await test("CLV-279 a delivery run keeps running while the watchdog reports a condition, and the session logs both changes with no command or read", async () => {
  const health: { condition: string | undefined } = { condition: undefined };
  const recorded = recorder();
  const stopping = new AbortController();
  const aborted: boolean[] = [];
  const authority = authoritySession({
    ...parts,
    run: async (signal) => {
      health.condition = "stranded message m-1";
      await until(() => recorded.lines.length === 1);
      health.condition = undefined;
      await until(() => recorded.lines.length === 2);
      aborted.push(signal.aborted);
    },
    condition: () => Promise.resolve(health.condition),
    logger: recorded.logger,
    watchMilliseconds: testMilliseconds(20),
  });
  await authority.deliver(stopping.signal);
  assert.deepEqual(aborted, [false]);
  assert.deepEqual(
    recorded.lines.map(([level]) => level),
    ["warn", "info"],
  );
});

await test("CLV-279 a command whose call times out gets a failed receipt and leaves the session open", async () => {
  const timeouts = [
    Object.assign(new Error("the call timed out"), { name: "SyncTimeout" }),
  ];
  const stops: string[] = [];
  const authority = authoritySession({
    ...parts,
    execute: () => {
      const timeout = timeouts.shift();
      return timeout === undefined
        ? Promise.resolve(accepted)
        : Promise.reject(timeout);
    },
    stop: () => {
      stops.push("stop");
      return Promise.resolve();
    },
  });
  assert.deepEqual(
    await authority.execute(pause("c-1"), context),
    refusal("SyncTimeout: the call timed out"),
  );
  assert.deepEqual(await authority.execute(pause("c-2"), context), accepted);
  assert.deepEqual(stops, []);
});

await test("CLV-279 a command gets a failed receipt and no call when the health lookup fails before the call, and the session stays open", async () => {
  const { authority, calls } = recordingSession(
    lookups([new Error("lookup failed")]),
  );
  assert.deepEqual(
    await authority.execute(pause("c-1"), context),
    refusal("Error: lookup failed"),
  );
  assert.deepEqual(await authority.execute(pause("c-2"), context), accepted);
  assert.deepEqual(calls, ["execute"]);
});

await test("CLV-279 a command keeps its committed receipt when the health lookup fails after the call, and the session stays open", async () => {
  const { authority, calls } = recordingSession(
    lookups([undefined, new Error("lookup failed")]),
  );
  assert.deepEqual(await authority.execute(pause("c-1"), context), accepted);
  assert.deepEqual(calls, ["execute"]);
});
