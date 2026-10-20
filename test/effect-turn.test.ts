import { testMilliseconds } from "./test-timing.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectReport,
  effectRequest,
  later,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

function leaseCommand(operationId: string, generation: number): string {
  const digest = createHash("sha256").update(operationId).digest("hex");
  return `lease:${digest}:${String(generation)}`;
}

await test("CLV-049 a request for a protected effect and its lease grant commit in one turn, and the receipt gives the disposition and the sequence of the request", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  assert.deepEqual(await send(request.command, request.documents), {
    kind: "accepted",
    sequence: 3,
    intents: [],
    disposition: "admitted",
  });
  assert.deepEqual(
    (await authority.events()).slice(2).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      commandId: event.commandId,
      payload: event.payload,
    })),
    [
      {
        sequence: 3,
        type: "effect.requested",
        commandId: "c-request",
        payload: {
          operationId,
          capability: "fake-harness",
          method: "run-turn",
          target: "workspace/main",
          payload: digestOf("build the package"),
          inputDigest: request.inputDigest,
          units: "1",
          recoveryLimit: "3",
        },
      },
      {
        sequence: 4,
        type: "lease.granted",
        commandId: leaseCommand(operationId, 1),
        payload: {
          operationId,
          leaseGeneration: "1",
          expiresAt: later,
          capacity: "4",
        },
      },
    ],
  );
  await authority.close();
});

await test("CLV-049 after the turn of a request, the operation is dispatch-pending with one open dispatch attempt of its lease generation, and the rows carry the sequence of the grant", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const { operationId } = request;
  await send(request.command, request.documents);
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.status, operation?.leaseGeneration, operation?.leaseKey],
    ["dispatch-pending", 1, operationId],
  );
  assert.deepEqual(await authority.effects.disposition(3), {
    runId: "run-1",
    operationId,
    disposition: "admitted",
    reason: null,
  });
  assert.equal(await authority.effects.disposition(4), undefined);
  assert.deepEqual(
    (await authority.eligibleIntents()).map((intent) => intent.kind),
    ["protected-effect"],
  );
  const { epoch } = authority;
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT o.created_sequence, r.sequence, a.purpose, a.lease_generation, a.authority_epoch, d.outcome FROM outbox o JOIN runs r ON r.run_id = o.run_id JOIN deliveries d ON d.operation_id = o.operation_id JOIN dispatch_attempts a ON a.effect_id = d.effect_id WHERE o.kind = 'protected-effect'",
    ),
    [
      {
        created_sequence: 4,
        sequence: 4,
        purpose: "dispatch",
        lease_generation: 1,
        authority_epoch: epoch,
        outcome: null,
      },
    ],
  );
  await (await openedAuthority(directory)).close();
});

await test("CLV-049 a start has a dispatch attempt record with no lease generation", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  await runningRun(sender(authority, { now: noon }), { effectLimit: 5 });
  const records = await authority.operations();
  assert.deepEqual(
    records.map((record) => [
      record.kind,
      record.deliveries.map((delivery) => [delivery.purpose, delivery.epoch]),
    ]),
    [["start-run", [["dispatch", authority.epoch]]]],
  );
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT purpose, lease_generation, authority_epoch FROM dispatch_attempts",
    ),
    [{ purpose: "dispatch", lease_generation: null, authority_epoch: 1 }],
  );
});

await test("CLV-049 the promotion uses the capacity setting: at the bound 1 the second operation waits, and its grant event records the bound", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, {
    effects: { capacity: 1, leaseMilliseconds: testMilliseconds(60_000) },
  });
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const first = effectRequest({ commandId: "c-request-1", round: 1 });
  const second = effectRequest({ commandId: "c-request-2", round: 2 });
  for (const request of [first, second])
    assert.equal(
      (await send(request.command, request.documents)).kind,
      "accepted",
    );
  const granted = (await authority.events()).filter(
    (event) => event.type === "lease.granted",
  );
  assert.deepEqual(
    granted.map((event) => [
      event.payload["operationId"],
      event.payload["capacity"],
      event.payload["expiresAt"],
    ]),
    [
      [
        first.operationId,
        "1",
        new Date(Date.parse(noon) + testMilliseconds(60_000)).toISOString(),
      ],
    ],
  );
  const waiting = await authority.effects.operation(second.operationId);
  assert.deepEqual(
    [waiting?.status, waiting?.reason, waiting?.leaseGeneration],
    ["waiting", "ready", null],
  );
  await authority.close();
});

await test("CLV-049 an effect capacity outside 1 to 8 or a lease duration that is not positive refuses the opening", async () => {
  for (const effects of [
    { capacity: 0 },
    { capacity: 9 },
    { capacity: 1.5 },
    { leaseMilliseconds: testMilliseconds(0) },
    { stopLimit: 0 },
  ]) {
    const opening = await openAuthority(await temporaryDirectory(), {
      effects,
    });
    assert.equal(opening.kind, "refused", JSON.stringify(effects));
    assert.equal(opening.reason, "invalid-configuration");
  }
});

await test("CLV-049 a command from outside the plan with a plan kind or a plan command ID is refused and commits nothing", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  await send(request.command, request.documents);
  const { operationId } = request;
  const before = (await authority.events()).length;
  for (const command of [
    {
      kind: "grant-lease",
      commandId: "c-grant",
      runId: "run-1",
      operationId,
      leaseGeneration: 2,
      expiresAt: later,
      capacity: 4,
    },
    {
      kind: "record-outcome",
      commandId: "c-outcome",
      runId: "run-1",
      operationId,
      outcome: "completed",
      leaseGeneration: 1,
    },
    { ...request.command, commandId: "lease:forged" },
    { ...request.command, commandId: "outcome:forged" },
    { ...request.command, commandId: "dispatch:forged" },
  ])
    assert.deepEqual(
      await send(command, request.documents),
      { kind: "rejected", reason: "delivery-owned-command" },
      JSON.stringify(command),
    );
  assert.equal((await authority.events()).length, before);
  await authority.close();
});

await test("CLV-049 the authority rejects a worker result command without the present epoch", async () => {
  const directory = await temporaryDirectory();
  await (await openedAuthority(directory)).close();
  const authority = await openedAuthority(directory);
  assert.equal(authority.epoch, 2);
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const report = effectReport(request, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  for (const [command, documents] of [
    [request.command, request.documents],
    [report.command, report.documents],
  ] as const) {
    assert.deepEqual(
      await authority.execute(command, { recordedAt: noon, documents }),
      { kind: "rejected", reason: "missing-epoch" },
    );
    assert.deepEqual(
      await authority.execute(command, {
        recordedAt: noon,
        documents,
        epoch: 1,
      }),
      { kind: "rejected", reason: "stale-epoch" },
    );
  }
  assert.equal((await authority.events()).length, 2);
  assert.equal(
    await authority.queries.document(digestOf("the result")),
    undefined,
  );
  await authority.close();
});

await test("CLV-049 a protected effect command with a recorded time that is not an instant is rejected and commits nothing", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await runningRun(sender(authority, { now: noon }), { effectLimit: 5 });
  const request = effectRequest({ commandId: "c-request", round: 1 });
  for (const now of ["", "2026-10-10", "noon"])
    assert.deepEqual(
      await sender(authority, { now })(request.command, request.documents),
      { kind: "rejected", reason: "invalid-recorded-time" },
      now,
    );
  assert.equal((await authority.events()).length, 2);
  await authority.close();
});

await test("CLV-049 the state of the authority keeps its present parts, and the effect records are read by operation", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await runningRun(sender(authority, { now: noon }), { effectLimit: 5 });
  assert.deepEqual(Object.keys(await authority.state()).sort(), [
    "commands",
    "details",
    "gates",
    "intents",
    "questions",
    "runs",
    "sequence",
  ]);
  assert.equal(await authority.effects.operation("unknown"), undefined);
  await authority.close();
});

await test("CLV-049 a resume commits one lease grant for each waiting operation in its turn, and the stored rows agree with the replay at the next opening", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory);
  const send = sender(authority, { now: noon });
  await runningRun(send, { effectLimit: 5 });
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-1" };
  await send({ ...pause, expectedRevision: 2 });
  const requests = [1, 2].map((round) =>
    effectRequest({ commandId: `c-request-${String(round)}`, round }),
  );
  for (const request of requests)
    await send(request.command, request.documents);
  const waiting = await authority.effects.operation(
    requests[0]?.operationId ?? "",
  );
  assert.deepEqual(
    [waiting?.status, waiting?.reason],
    ["waiting", "run-not-running"],
  );
  const resumed = await send({
    ...pause,
    kind: "resume-run",
    commandId: "c-resume",
    expectedRevision: 3,
  });
  assert.deepEqual(
    [resumed.kind, Reflect.get(resumed, "sequence")],
    ["accepted", 6],
  );
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT o.created_sequence, l.granted_sequence, l.generation FROM outbox o JOIN leases l ON l.operation_id = o.operation_id WHERE o.kind = 'protected-effect' ORDER BY o.created_sequence",
    ),
    [
      { created_sequence: 7, granted_sequence: 7, generation: 1 },
      { created_sequence: 8, granted_sequence: 8, generation: 1 },
    ],
  );
  const reopened = await openedAuthority(directory);
  assert.equal((await reopened.eligibleIntents()).length, 2);
  await reopened.close();
});
