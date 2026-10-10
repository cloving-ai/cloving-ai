import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  authorityTiming,
  type Authority,
  type Delivery,
} from "../src/broker/actor/authority.ts";
import {
  executePinned,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const deadLetter =
  /^Error: authority-unavailable: dead-lettered message [0-9a-f-]{36}: injected-callback-failure$/;

interface GatedRun {
  readonly delivery: Delivery;
  readonly entered: Promise<void>;
  readonly release: () => void;
}

function gatedRun(runId: string): GatedRun {
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
        if (intent.runId === runId) {
          entry.resolve(undefined);
          await gate.promise;
        }
        return { receipt: `receipt-${String(sent.length)}` };
      },
      reconcile: () => Promise.resolve({ kind: "absent" }),
    },
  };
}

async function admittedRuns(
  directory: string,
  runIds: readonly string[],
): Promise<void> {
  const authority = await openedAuthority(directory);
  for (const runId of runIds)
    assert.equal(
      (
        await executePinned(authority, {
          ...admission,
          commandId: `admit-${runId}`,
          runId,
        })
      ).kind,
      "accepted",
    );
  await authority.close();
}

function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => String(error),
  );
}

await test("CLV-042 a storage failure while a delivery handler outlasts the shutdown bound returns the storage-failure receipt, and the delivery run reports the failure", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1"]);
  alterDatabase(
    directory,
    "CREATE TRIGGER inject BEFORE INSERT ON commands WHEN NEW.command_id = 'admit-run-2' BEGIN SELECT RAISE(ABORT, 'injected-command-failure'); END;",
  );
  const run = gatedRun("run-1");
  const authority = await openedAuthority(directory, {
    delivery: run.delivery,
    timing: { ...fastTiming, shutdownMilliseconds: 150 },
  });
  const delivering = outcome(authority.deliver(new AbortController().signal));
  await run.entered;
  try {
    assert.deepEqual(
      await executePinned(authority, {
        ...admission,
        commandId: "admit-run-2",
        runId: "run-2",
      }),
      {
        kind: "failed",
        reason: "storage-failure",
        detail: "injected-command-failure",
      },
    );
    assert.equal(
      await delivering,
      "Error: authority-unavailable: storage failure",
    );
  } finally {
    run.release();
  }
  await authority.close();
});

await test("CLV-042 a dead-lettered callback found while another delivery handler outlasts the shutdown bound is reported by the delivery run with its cause", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1", "run-2"]);
  alterDatabase(
    directory,
    "CREATE TRIGGER inject BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT, 'injected-callback-failure'); END;",
  );
  const run = gatedRun("run-2");
  const authority = await openedAuthority(directory, {
    delivery: run.delivery,
    timing: { ...fastTiming, shutdownMilliseconds: 150 },
  });
  const delivering = outcome(authority.deliver(new AbortController().signal));
  await run.entered;
  try {
    assert.match(await delivering, deadLetter);
  } finally {
    run.release();
  }
  await authority.close();
});

const callbackFailure =
  "CREATE TRIGGER inject BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT, 'injected-callback-failure'); END;";
const closedAfterDeadLetter =
  /^closed after dead-lettered message [0-9a-f-]{36}: injected-callback-failure$/;

function refusedReceipt(receipt: unknown, detail: RegExp): void {
  assert.equal(Reflect.get(Object(receipt), "kind"), "failed");
  assert.equal(Reflect.get(Object(receipt), "reason"), "storage-unavailable");
  assert.match(String(Reflect.get(Object(receipt), "detail")), detail);
}

function storedCommands(directory: string): unknown {
  return queryDatabase(
    directory,
    "SELECT command_id FROM commands ORDER BY sequence",
  ).map((row): unknown => Reflect.get(Object(row), "command_id"));
}

await test("CLV-042 a dead-lettered callback found by the watchdog stops admission before the next command, and later commands, reads and the delivery run report its cause", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1"]);
  alterDatabase(directory, callbackFailure);
  const run = gatedRun("none");
  const dead = Promise.withResolvers<undefined>();
  const authority = await openedAuthority(directory, {
    delivery: run.delivery,
    timing: authorityTiming,
    instrumentation: (event) => {
      if (event.name === "solid_objects.dead_letter.created")
        dead.resolve(undefined);
    },
  });
  const delivering = outcome(authority.deliver(new AbortController().signal));
  await dead.promise;
  const receipts = await Promise.all(
    ["run-2", "run-3"].map((runId) =>
      executePinned(authority, {
        ...admission,
        commandId: `admit-${runId}`,
        runId,
      }),
    ),
  );
  for (const receipt of receipts)
    refusedReceipt(receipt, closedAfterDeadLetter);
  assert.match(await delivering, deadLetter);
  await assert.rejects(authority.state(), deadLetter);
  await authority.close();
  assert.deepEqual(storedCommands(directory), ["admit-run-1"]);
});

await test("CLV-042 a queued callback that a command applies and dead-letters keeps the committed receipt, and later commands and reads report the cause", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1"]);
  alterDatabase(directory, callbackFailure);
  const stopping = new AbortController();
  const authority = await openedAuthority(directory, {
    timing: fastTiming,
    delivery: {
      deliver: () => {
        stopping.abort();
        return Promise.resolve({ receipt: "receipt-1" });
      },
      reconcile: () => Promise.resolve({ kind: "absent" }),
    },
  });
  await authority.deliver(stopping.signal);
  assert.equal(
    (
      await executePinned(authority, {
        ...admission,
        commandId: "admit-run-2",
        runId: "run-2",
      })
    ).kind,
    "accepted",
  );
  await assert.rejects(authority.state(), deadLetter);
  refusedReceipt(
    await executePinned(authority, {
      ...admission,
      commandId: "admit-run-3",
      runId: "run-3",
    }),
    closedAfterDeadLetter,
  );
  await authority.close();
  assert.deepEqual(storedCommands(directory), ["admit-run-1", "admit-run-2"]);
});

await test("CLV-042 a failed read of the dead-letter cause still fails the authority closed and reports the condition", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1"]);
  alterDatabase(directory, callbackFailure);
  alterDatabase(
    directory,
    "CREATE TRIGGER unreadable AFTER INSERT ON solid_dead_letters BEGIN UPDATE solid_dead_letters SET error = 'not-json' WHERE id = NEW.id; END;",
  );
  const run = gatedRun("none");
  const authority = await openedAuthority(directory, {
    delivery: run.delivery,
    timing: fastTiming,
  });
  const unreadable =
    /^Error: authority-unavailable: dead-lettered message [0-9a-f-]{36}: unreadable cause$/;
  assert.match(
    await outcome(authority.deliver(new AbortController().signal)),
    unreadable,
  );
  refusedReceipt(
    await executePinned(authority, {
      ...admission,
      commandId: "admit-run-2",
      runId: "run-2",
    }),
    /^closed after dead-lettered message [0-9a-f-]{36}: unreadable cause$/,
  );
  await assert.rejects(authority.state(), unreadable);
  await authority.close();
  assert.deepEqual(storedCommands(directory), ["admit-run-1"]);
});

await test("CLV-042 a command that is in flight when another command fails the authority closed gets the receipt of its commit", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1"]);
  alterDatabase(
    directory,
    "CREATE TRIGGER inject BEFORE INSERT ON commands WHEN NEW.command_id = 'admit-run-2' BEGIN SELECT RAISE(ABORT, 'injected-command-failure'); END;",
  );
  const authority = await openedAuthority(directory, { timing: fastTiming });
  const [failing, following] = await Promise.all(
    ["run-2", "run-3"].map((runId) =>
      executePinned(authority, {
        ...admission,
        commandId: `admit-${runId}`,
        runId,
      }),
    ),
  );
  assert.deepEqual(failing, {
    kind: "failed",
    reason: "storage-failure",
    detail: "injected-command-failure",
  });
  assert.equal(following?.kind, "accepted");
  await authority.close();
  assert.deepEqual(storedCommands(directory), ["admit-run-1", "admit-run-3"]);
});

async function deadLetteredWhileStuck(directory: string): Promise<{
  readonly authority: Authority;
  readonly run: GatedRun;
  readonly delivering: Promise<string>;
}> {
  await admittedRuns(directory, ["run-1", "run-2"]);
  alterDatabase(directory, callbackFailure);
  const run = gatedRun("run-2");
  const dead = Promise.withResolvers<undefined>();
  const authority = await openedAuthority(directory, {
    delivery: run.delivery,
    timing: { ...authorityTiming, shutdownMilliseconds: 600 },
    instrumentation: (event) => {
      if (event.name === "solid_objects.dead_letter.created")
        dead.resolve(undefined);
    },
  });
  const delivering = outcome(authority.deliver(new AbortController().signal));
  await Promise.all([run.entered, dead.promise]);
  return { authority, run, delivering };
}

await test("CLV-042 commands after a detected condition are refused at once, without a wait for the delivery run to stop", async () => {
  const directory = await temporaryDirectory();
  const { authority, run, delivering } =
    await deadLetteredWhileStuck(directory);
  try {
    const started = performance.now();
    for (const runId of ["run-3", "run-4"])
      refusedReceipt(
        await executePinned(authority, {
          ...admission,
          commandId: `admit-${runId}`,
          runId,
        }),
        closedAfterDeadLetter,
      );
    assert.ok(performance.now() - started < 400);
  } finally {
    run.release();
  }
  assert.match(await delivering, deadLetter);
  await authority.close();
});

await test("CLV-042 a read in the same step as the command that finds a condition reports the condition, and settings reject instead of throwing", async () => {
  const directory = await temporaryDirectory();
  const { authority, run, delivering } =
    await deadLetteredWhileStuck(directory);
  try {
    const command = executePinned(authority, {
      ...admission,
      commandId: "admit-run-3",
      runId: "run-3",
    });
    const read = outcome(authority.state());
    refusedReceipt(await command, closedAfterDeadLetter);
    assert.match(
      await read,
      /^Error: authority-unavailable: dead-lettered message [0-9a-f-]{36}(: injected-callback-failure)?$/,
    );
    await assert.rejects(authority.settings(), deadLetter);
  } finally {
    run.release();
  }
  assert.match(await delivering, deadLetter);
  await authority.close();
});

await test("CLV-042 after a close that reports the shutdown timeout, the session refuses commands and reads, and a later close resolves when the authority is released", async () => {
  const directory = await temporaryDirectory();
  await admittedRuns(directory, ["run-1"]);
  const run = gatedRun("run-1");
  const timing = { ...fastTiming, shutdownMilliseconds: 150 };
  const authority = await openedAuthority(directory, {
    delivery: run.delivery,
    timing,
  });
  const delivering = outcome(authority.deliver(new AbortController().signal));
  await run.entered;
  try {
    assert.equal(
      await outcome(authority.close()),
      "Error: authority-close-timeout: in-flight delivery handlers: 1",
    );
    assert.equal(await delivering, "resolved");
    assert.deepEqual(
      await executePinned(authority, {
        ...admission,
        commandId: "admit-run-2",
        runId: "run-2",
      }),
      { kind: "failed", reason: "storage-unavailable", detail: "closed" },
    );
    await assert.rejects(
      authority.state(),
      /^Error: authority-unavailable: closed$/,
    );
  } finally {
    run.release();
  }
  await authority.close();
  await (await openedAuthority(directory, { timing })).close();
});

after(removeTemporaryDirectories);
