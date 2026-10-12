import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectReport,
  effectRequest,
  fakeDestination,
  inputDigest,
  noon,
  operationOf,
  runningRun,
  sender,
  type Destination,
  type Request,
  type Send,
} from "./effect-fixture.ts";

after(removeTemporaryDirectories);

interface Scene {
  readonly authority: Authority;
  readonly destination: Destination;
  readonly directory: string;
  readonly send: Send;
}

async function reopened(
  directory: string,
  destination: Destination,
): Promise<Scene> {
  const authority = await openedAuthority(directory, {
    delivery: destination.delivery,
    clock: () => noon,
    timing: fastTiming,
  });
  return {
    authority,
    destination,
    directory,
    send: sender(authority, { now: noon }),
  };
}

async function scene(): Promise<Scene> {
  const started = await reopened(await temporaryDirectory(), fakeDestination());
  await runningRun(started.send, { effectLimit: 5 });
  return started;
}

function sentUntil(
  authority: Authority,
  expected: { readonly operationId: string; readonly status: string },
): Promise<void> {
  return deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(expected.operationId))?.status ===
      expected.status,
  );
}

function field(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

async function dispositions(
  authority: Authority,
  sequences: readonly number[],
): Promise<readonly (string | undefined)[]> {
  const stored = [];
  for (const sequence of sequences)
    stored.push((await authority.effects.disposition(sequence))?.disposition);
  return stored;
}

await test("CLV-049 a retry of the same action returns the same operation ID and the same input digest and adds no second intent", async () => {
  const { authority, destination, send } = await scene();
  const first = effectRequest({ commandId: "c-request", round: 1 });
  const retry = effectRequest({ commandId: "c-retry", round: 1 });
  assert.deepEqual(
    [retry.operationId, retry.inputDigest],
    [first.operationId, first.inputDigest],
  );
  const admitted = await send(first.command, first.documents);
  const existing = await send(retry.command, retry.documents);
  const duplicate = await send(first.command, first.documents);
  assert.deepEqual(
    [admitted, existing, duplicate].map((receipt) => [
      receipt.kind,
      field(receipt, "sequence"),
      field(receipt, "disposition"),
    ]),
    [
      ["accepted", 3, "admitted"],
      ["accepted", 5, "existing"],
      ["duplicate", 3, undefined],
    ],
  );
  await sentUntil(authority, {
    operationId: first.operationId,
    status: "running",
  });
  const records = (await authority.operations()).filter(
    (record) => record.kind === "protected-effect",
  );
  assert.deepEqual(
    records.map((record) => [record.operationId, record.deliveries.length]),
    [[first.operationId, 1]],
  );
  assert.equal(
    (await authority.effects.operation(first.operationId))?.inputDigest,
    first.inputDigest,
  );
  assert.deepEqual(destination.effects, [first.operationId]);
  await authority.close();
});

await test("CLV-049 a new loop visit gets a new operation ID", async () => {
  const { authority, destination, send } = await scene();
  const visits = [1, 2].map((round) =>
    effectRequest({ commandId: `c-request-${String(round)}`, round }),
  );
  const [first, second] = visits.map((visit) => visit.operationId);
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(first, second);
  assert.equal(operationOf("run-1", { round: 2 }), second);
  for (const visit of visits) {
    const receipt = await send(visit.command, visit.documents);
    assert.equal(Reflect.get(receipt, "disposition"), "admitted");
  }
  await sentUntil(authority, { operationId: second, status: "running" });
  await sentUntil(authority, { operationId: first, status: "running" });
  assert.deepEqual([...destination.effects].sort(), [first, second].sort());
  await authority.close();
});

type Fields = Readonly<Record<string, unknown>>;

function changed(request: Request, fields: Fields): Request {
  const command: Fields = {
    ...request.command,
    ...fields,
    commandId: "c-changed",
  };
  return {
    ...request,
    command: {
      ...command,
      inputDigest: inputDigest({
        capability: String(command["capability"]),
        method: String(command["method"]),
        target: String(command["target"]),
        payload: String(command["payload"]),
      }),
    },
  };
}

await test("CLV-049 the authority rejects a changed input under a known operation ID", async () => {
  const { authority, send } = await scene();
  const request = effectRequest({ commandId: "c-request", round: 1 });
  await send(request.command, request.documents);
  const stored = await authority.effects.operation(request.operationId);
  const events = (await authority.events()).length;
  for (const [fields, documents] of [
    [{ payload: digestOf("a different text") }, ["a different text"]],
    [{ target: "workspace/other" }, request.documents],
    [{ method: "stop-turn" }, request.documents],
    [{ units: 2 }, request.documents],
    [{ resource: "repository" }, request.documents],
  ] as const) {
    const different = changed(request, fields);
    assert.deepEqual(
      await send(different.command, documents),
      { kind: "rejected", reason: "changed-operation-input" },
      JSON.stringify(fields),
    );
  }
  assert.equal((await authority.events()).length, events);
  assert.deepEqual(
    await authority.effects.operation(request.operationId),
    stored,
  );
  assert.equal(
    await authority.queries.document(digestOf("a different text")),
    undefined,
  );
  await authority.close();
});

await test("CLV-049 the authority rejects a request whose input digest is not the digest of its capability, method, target and payload", async () => {
  const { authority, send } = await scene();
  const request = effectRequest({ commandId: "c-request", round: 1 });
  const events = (await authority.events()).length;
  for (const fields of [
    { inputDigest: digestOf("a different text") },
    { target: "workspace/other" },
    { capability: "other" },
  ])
    assert.deepEqual(
      await send({ ...request.command, ...fields }, request.documents),
      { kind: "rejected", reason: "input-digest-mismatch" },
      JSON.stringify(fields),
    );
  assert.equal((await authority.events()).length, events);
  await authority.close();
});

await test("CLV-049 a new SDK retry ID, a new tool-call ID or a new host generation for the same logical operation adds no logical action", async () => {
  const first = await scene();
  const { destination, directory } = first;
  const calls = ["sdk-retry-1 of tool-call-7", "sdk-retry-2 of tool-call-7"];
  const requests = [...calls, "sdk-retry-1 of tool-call-9"].map(
    (transport, index) =>
      effectRequest({
        commandId: `c-request-${String(index)}`,
        round: 1,
        transport,
      }),
  );
  const { operationId } = effectRequest({ commandId: "c-request", round: 1 });
  const sequences: number[] = [];
  for (const request of requests.slice(0, 2))
    sequences.push(
      Number(
        Reflect.get(
          await first.send(request.command, request.documents),
          "sequence",
        ),
      ),
    );
  await sentUntil(first.authority, { operationId, status: "running" });
  await first.authority.close();
  const second = await reopened(directory, destination);
  assert.equal(second.authority.epoch, first.authority.epoch + 1);
  const later = requests[2];
  assert.ok(later);
  sequences.push(
    Number(
      Reflect.get(
        await second.send(later.command, later.documents),
        "sequence",
      ),
    ),
  );
  await deliverUntil(
    second.authority,
    async () => (await second.authority.eligibleIntents()).length === 0,
  );
  assert.deepEqual(await dispositions(second.authority, sequences), [
    "admitted",
    "existing",
    "existing",
  ]);
  assert.deepEqual(
    (await second.authority.events())
      .filter((event) => event.type === "effect.requested")
      .map((event) => event.payload["transport"]),
    [...calls, "sdk-retry-1 of tool-call-9"],
  );
  assert.deepEqual(destination.effects, [operationId]);
  assert.equal(
    destination.calls.filter((call) => call.startsWith("deliver")).length,
    1,
  );
  await second.authority.close();
});

type View = Awaited<ReturnType<Authority["effects"]["operation"]>>;

interface Ownership {
  readonly records: Awaited<ReturnType<Authority["operations"]>>;
  readonly views: readonly View[];
  readonly eligible: Awaited<ReturnType<Authority["eligibleIntents"]>>;
}

async function ownership(
  authority: Authority,
  operations: readonly string[],
): Promise<Ownership> {
  const views: View[] = [];
  for (const operationId of operations)
    views.push(await authority.effects.operation(operationId));
  return {
    records: await authority.operations(),
    views,
    eligible: await authority.eligibleIntents(),
  };
}

interface Requests {
  readonly held: Request;
  readonly waiting: Request;
  readonly settled: Request;
}

async function threeOperations(started: Scene): Promise<Requests> {
  const { authority, send } = started;
  const [held, waiting, settled] = [
    effectRequest({ commandId: "c-1", round: 1, resource: "repository" }),
    effectRequest({ commandId: "c-2", round: 2, resource: "repository" }),
    effectRequest({ commandId: "c-3", round: 3 }),
  ];
  for (const request of [held, waiting, settled])
    await send(request.command, request.documents);
  for (const request of [settled, held])
    await sentUntil(authority, {
      operationId: request.operationId,
      status: "running",
    });
  const report = effectReport(settled, {
    commandId: "c-report",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the result",
  });
  const applied = await send(report.command, report.documents);
  assert.equal(Reflect.get(applied, "disposition"), "applied");
  return { held, waiting, settled };
}

await test("CLV-049 a restart keeps the operation IDs, the outbox transitions and the ownership values", async () => {
  const first = await scene();
  const { authority, destination, directory } = first;
  const { held, waiting, settled } = await threeOperations(first);
  const ids = [held, waiting, settled].map((request) => request.operationId);
  const before = await ownership(authority, ids);
  assert.deepEqual(
    before.views.map((view) => [
      view?.status,
      view?.leaseGeneration,
      view?.worker,
    ]),
    [
      ["running", 1, "worker-1"],
      ["waiting", null, null],
      ["completed", null, "worker-1"],
    ],
  );
  await authority.close();
  const second = await reopened(directory, destination);
  assert.deepEqual(await ownership(second.authority, ids), before);
  assert.equal(second.authority.epoch, authority.epoch + 1);
  const released = effectReport(held, {
    commandId: "c-report-held",
    leaseGeneration: 1,
    worker: "worker-1",
    result: "the first result",
  });
  await second.send(released.command, released.documents);
  const next = await second.authority.effects.operation(waiting.operationId);
  assert.deepEqual(
    [next?.status, next?.leaseGeneration],
    ["dispatch-pending", 2],
  );
  assert.deepEqual(
    (await second.authority.operations())
      .filter((record) => record.operationId === waiting.operationId)
      .flatMap((record) =>
        record.deliveries.map((item) => [item.purpose, item.epoch]),
      ),
    [["dispatch", second.authority.epoch]],
  );
  await second.authority.close();
});
