import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stopAttempts } from "../src/authority/stop-sequence.ts";
import { droppedRuns, stopping } from "../src/broker/actor/stop-turn.ts";
import { commandTurn } from "../src/broker/actor/turn-state.ts";
import {
  deliverUntil,
  executePinned,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  alterDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  effectReport,
  leaseExpiry,
  noon,
  type Request,
} from "./effect-fixture.ts";
import {
  drop,
  droppedWithNoStop,
  finalAt,
  quiet,
  runningEffects,
  scene,
  stopped,
} from "./effect-stop-fixture.ts";
import {
  bounded,
  droppedAtTheBound,
  empty,
  start,
  stored,
  unavailable,
  unreachable,
} from "./stop-opening-fixture.ts";

after(removeTemporaryDirectories);

function turnOf(
  directory: string,
  command: Readonly<Record<string, unknown>>,
): ReturnType<typeof commandTurn> {
  return stored(directory, (connection) =>
    commandTurn(connection, { command, sequence: 0, capacity: 4 }),
  );
}

const pause = {
  kind: "pause-run",
  commandId: "c-pause",
  runId: "run-1",
  expectedRevision: 2,
};

async function threeEffects(): Promise<{
  readonly directory: string;
  readonly requests: readonly [Request, Request, Request];
}> {
  const started = await scene(stopped);
  const [first, second, done] = await runningEffects(started, [1, 2, 3]);
  assert.ok(first !== undefined && second !== undefined && done !== undefined);
  const report = effectReport(done, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  await started.send(report.command, report.documents);
  await started.authority.close();
  return { directory: started.directory, requests: [first, second, done] };
}

await test("CLV-049 a turn of a run that is not dropped loads no stop data, and the turn of its drop loads only the operations that are not resolved", async () => {
  const { directory, requests } = await threeEffects();
  const [first, second] = requests;
  assert.deepEqual((await turnOf(directory, pause)).stopping, {
    subjects: [],
    cancelledSequence: null,
  });
  const dropping = (await turnOf(directory, drop)).stopping;
  assert.deepEqual(
    dropping.subjects.map((subject) => [subject.kind, subject.status]).sort(),
    [
      ["protected-effect", "running"],
      ["protected-effect", "running"],
      ["start-run", null],
    ],
  );
  assert.deepEqual(
    dropping.subjects
      .filter((subject) => subject.kind === "protected-effect")
      .map((subject) => subject.operationId)
      .sort(),
    [first.operationId, second.operationId].sort(),
  );
});

await test("CLV-049 a turn of a dropped run loads an operation that is not resolved or has an open attempt, and no operation that is resolved with each attempt closed", async () => {
  const { directory, requests } = await threeEffects();
  const [first, second] = requests;
  const again = await scene(stopped, directory);
  assert.equal((await again.send(drop)).kind, "accepted");
  const settling = effectReport(first, {
    commandId: "c-report-first",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  await again.send(settling.command, settling.documents);
  await again.authority.close();
  const open = (await turnOf(directory, pause)).stopping;
  assert.deepEqual(
    open.subjects
      .filter((subject) => subject.operationId === first.operationId)
      .map((subject) => [
        subject.status,
        subject.attempts.map((attempt) => attempt.outcome),
      ]),
    [["completed", ["accepted", null]]],
  );
  const settled = await scene(stopped, directory);
  await finalAt(settled.authority, { request: second, status: "stopped" });
  await quiet(settled.authority);
  await settled.authority.close();
  const later = (await turnOf(directory, pause)).stopping;
  assert.deepEqual(
    later.subjects.map((subject) => [subject.kind, subject.attempts.length]),
    [["start-run", 1]],
  );
  assert.equal(typeof later.cancelledSequence, "number");
});

function listed(directory: string): Promise<readonly (readonly string[])[]> {
  return stored(directory, async (connection) => [
    await droppedRuns(connection, { limit: 100, stopSupported: true }),
    await droppedRuns(connection, { limit: 100, stopSupported: false }),
  ]);
}

async function sentStart(): Promise<string> {
  const sent = await scene(undefined);
  await executePinned(sent.authority, start);
  await deliverUntil(
    sent.authority,
    async () => (await sent.authority.eligibleIntents()).length === 0,
  );
  await sent.authority.execute(
    { ...drop, expectedRevision: 1 },
    { recordedAt: noon },
  );
  await quiet(sent.authority);
  await sent.authority.close();
  return sent.directory;
}

await test("CLV-049 an opening lists a dropped run with a sent start only for an adapter with a stop function, and no more after the confirmed stop", async () => {
  const directory = await sentStart();
  assert.deepEqual(await listed(directory), [["run-1"], []]);
  const stopping = await scene(stopped, directory);
  await deliverUntil(
    stopping.authority,
    async () =>
      (await stopping.authority.effects.closure("run-1")).closure ===
      "cancelled",
  );
  await stopping.authority.close();
  assert.deepEqual(await listed(directory), [[], []]);
  assert.deepEqual((await turnOf(directory, pause)).stopping.subjects, []);
});

const failedRows = [
  [
    ["dispatch", "failed"],
    ["reconcile", "failed"],
  ],
];

await test("CLV-049 an opening lists a dropped run whose start has no known result, and no more after a reconciliation finds no effect", async () => {
  const unknown = await temporaryDirectory();
  const failing = await openedAuthority(unknown, {
    ...bounded,
    delivery: unreachable().delivery,
  });
  await droppedAtTheBound(failing, { runs: ["run-1"], bounded: 1 });
  await failing.close();
  assert.deepEqual(await listed(unknown), [["run-1"], ["run-1"]]);
  const resolving = await openedAuthority(unknown, {
    ...bounded,
    delivery: empty().delivery,
  });
  await deliverUntil(
    resolving,
    async () =>
      (await resolving.effects.closure("run-1")).closure === "cancelled",
  );
  await resolving.close();
  assert.deepEqual(await listed(unknown), [[], []]);
  const failed = await temporaryDirectory();
  const throwing = await openedAuthority(failed, {
    ...bounded,
    delivery: unavailable(),
  });
  await droppedAtTheBound(throwing, { runs: ["run-1"], bounded: 1 });
  assert.deepEqual(
    (await throwing.operations()).map((record) =>
      record.deliveries.map((item) => [item.purpose, item.outcome]),
    ),
    failedRows,
  );
  await throwing.close();
  assert.deepEqual(await listed(failed), [["run-1"], ["run-1"]]);
});

await test("CLV-049 an opening lists a dropped run with an accepted effect and no stop function only after the lease time of the effect, and it does not list a run whose effect is final", async () => {
  const running = await droppedWithNoStop((delivery) => delivery);
  await running.authority.close();
  assert.deepEqual(await listed(running.directory), [["run-1"], []]);
  const expired = await droppedWithNoStop((delivery) => delivery);
  expired.clock.now = "2026-10-10T12:30:00.000Z";
  await expired.send({ ...leaseExpiry(expired.request, 1) });
  await quiet(expired.authority);
  await expired.authority.close();
  assert.deepEqual(await listed(expired.directory), [["run-1"], ["run-1"]]);
  const settled = await scene(stopped);
  const [request] = await runningEffects(settled, [1]);
  assert.ok(request);
  await settled.send(drop);
  await finalAt(settled.authority, { request, status: "stopped" });
  await quiet(settled.authority);
  await settled.authority.close();
  assert.deepEqual(await listed(settled.directory), [[], []]);
});

const opening = {
  cancelledSequence: 0,
  stopLimit: 1,
  stopSupported: false,
  opening: true,
  rejected: new Set<string>(),
};

await test("CLV-049 the opening list agrees with the stop rule for an operation in work with no stored receipt, a row that the product does not make", async () => {
  const running = await droppedWithNoStop((delivery) => delivery);
  await running.authority.close();
  alterDatabase(running.directory, "UPDATE operations SET receipt = NULL");
  assert.deepEqual(await listed(running.directory), [["run-1"], ["run-1"]]);
  const loaded = await stored(running.directory, (connection) =>
    stopping(connection, "run-1"),
  );
  assert.deepEqual(
    stopAttempts(loaded.subjects, opening).map((attempt) => attempt.purpose),
    ["reconcile"],
  );
});
