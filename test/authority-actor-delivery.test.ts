import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  executePinned,
  externalService,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const operationId =
  '["cloving-operation",0,"run-1","admission","start-run",null,null]';

function command(fields: {
  readonly kind: string;
  readonly commandId: string;
  readonly expectedRevision: number;
}): Readonly<Record<string, unknown>> {
  return { ...fields, runId: "run-1" };
}

async function outcomes(authority: Authority): Promise<unknown> {
  return (await authority.operations()).map((operation) => [
    operation.operationId,
    operation.releasedSequence,
    operation.deliveries.map((delivery) => [
      delivery.outcome,
      delivery.receipt,
    ]),
  ]);
}

async function settledOutcome(
  authority: Authority,
  expected: unknown,
): Promise<void> {
  await deliverUntil(
    authority,
    async () =>
      JSON.stringify(await outcomes(authority)) === JSON.stringify(expected),
  );
}

await test("CLV-042 cancellation before delivery withholds the staged send and leaves the intent ineligible", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const authority = await openedAuthority(directory, service.options);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  assert.equal(
    (
      await executePinned(
        authority,
        command({ kind: "cancel-run", commandId: "c-9", expectedRevision: 1 }),
      )
    ).kind,
    "accepted",
  );
  await settledOutcome(authority, [[operationId, 2, [["withheld", null]]]]);
  assert.equal(service.sent.length, 0);
  assert.deepEqual(await authority.eligibleIntents(), []);
  assert.deepEqual(
    (await authority.events()).map((event) => event.type),
    ["run.created", "run.cancelled"],
  );
  await authority.close();
});

await test("CLV-042 a pause before delivery withholds the send, and the resume stages the same operation again for one delivery", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const authority = await openedAuthority(directory, service.options);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  assert.equal(
    (
      await executePinned(
        authority,
        command({ kind: "pause-run", commandId: "c-8", expectedRevision: 1 }),
      )
    ).kind,
    "accepted",
  );
  await settledOutcome(authority, [[operationId, null, [["withheld", null]]]]);
  assert.equal(service.sent.length, 0);
  assert.equal(
    (
      await executePinned(
        authority,
        command({ kind: "resume-run", commandId: "c-9", expectedRevision: 2 }),
      )
    ).kind,
    "accepted",
  );
  await settledOutcome(authority, [
    [
      operationId,
      4,
      [
        ["withheld", null],
        ["sent", "receipt-1"],
      ],
    ],
  ]);
  assert.deepEqual(
    service.sent.map((intent) => intent.operationId),
    [operationId],
  );
  await authority.close();
});

await test("CLV-042 a resume while the first delivery is still open stages no second effect", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const authority = await openedAuthority(directory, service.options);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  for (const step of [
    command({ kind: "pause-run", commandId: "c-8", expectedRevision: 1 }),
    command({ kind: "resume-run", commandId: "c-9", expectedRevision: 2 }),
  ])
    assert.equal((await executePinned(authority, step)).kind, "accepted");
  assert.deepEqual(await outcomes(authority), [
    [operationId, null, [[null, null]]],
  ]);
  await settledOutcome(authority, [[operationId, 4, [["sent", "receipt-1"]]]]);
  assert.equal(service.sent.length, 1);
  await authority.close();
});

after(removeTemporaryDirectories);
