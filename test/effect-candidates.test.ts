import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deliverUntil } from "./authority-actor-fixture.ts";
import {
  queryDatabase,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import {
  completed,
  reopened,
  requestOf,
  scene,
  settled,
  statuses,
} from "./effect-capacity-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-049 a waiting operation of a different run that has its outbox row from an earlier grant gets its next grant with no second outbox row", async () => {
  const started = await scene(1, ["run-1", "run-2"]);
  const { authority, destination, directory, send } = started;
  const first = requestOf("run-2", { round: 1 });
  const other = requestOf("run-1", { round: 1 });
  const pause = { kind: "pause-run", commandId: "c-pause", runId: "run-2" };
  await send(first.command, first.documents);
  await send({ ...pause, expectedRevision: 2 });
  await deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(first.operationId))?.status ===
      "waiting",
  );
  await send(other.command, other.documents);
  await settled(authority);
  await send({
    ...pause,
    kind: "resume-run",
    commandId: "c-resume",
    expectedRevision: 3,
  });
  assert.deepEqual(await statuses(authority, [first, other]), [
    ["waiting", "run-not-running", null],
    ["running", null, 1],
  ]);
  await completed(started, other);
  await settled(authority);
  assert.deepEqual(await statuses(authority, [first]), [["running", null, 2]]);
  assert.deepEqual(destination.effects, [other.operationId, first.operationId]);
  await authority.close();
  assert.deepEqual(
    queryDatabase(
      directory,
      `SELECT count(*) AS rows FROM outbox WHERE operation_id = '${first.operationId}'`,
    ),
    [{ rows: 1 }],
  );
  await (await reopened(started, { capacity: 1 })).authority.close();
});

await test("CLV-049 an older wait of a paused run does not take the candidate place of a wait of a running run", async () => {
  const started = await scene(1, ["run-1", "run-2", "run-3"]);
  const { authority, send } = started;
  const holder = requestOf("run-3", { round: 1 });
  const paused = requestOf("run-1", { round: 1 });
  const ready = requestOf("run-2", { round: 1 });
  await send(holder.command, holder.documents);
  await settled(authority);
  await send(paused.command, paused.documents);
  await send({
    kind: "pause-run",
    commandId: "c-pause",
    runId: "run-1",
    expectedRevision: 2,
  });
  await send(ready.command, ready.documents);
  await completed(started, holder);
  await settled(authority);
  assert.deepEqual(await statuses(authority, [paused, ready]), [
    ["waiting", "ready", null],
    ["running", null, 1],
  ]);
  await authority.close();
});

await test("CLV-049 an opening with free slots grants the oldest wait of each free key, and a younger wait of the same key stays", async () => {
  const runs = ["run-1", "run-2", "run-3", "run-4"];
  const first = await scene(1, runs);
  const holder = requestOf("run-1", { round: 1 });
  await first.send(holder.command, holder.documents);
  await settled(first.authority);
  const waits = [
    requestOf("run-2", { round: 1, resource: "key-k" }),
    requestOf("run-3", { round: 1, resource: "key-k" }),
    requestOf("run-4", { round: 1, resource: "key-k" }),
    requestOf("run-2", { round: 2, resource: "key-l" }),
  ];
  for (const request of waits)
    await first.send(request.command, request.documents);
  await first.authority.close();
  const second = await reopened(first, { capacity: 3 });
  assert.deepEqual(await statuses(second.authority, waits), [
    ["dispatch-pending", null, 1],
    ["waiting", "ready", null],
    ["waiting", "ready", null],
    ["dispatch-pending", null, 1],
  ]);
  await settled(second.authority);
  assert.deepEqual(await statuses(second.authority, waits), [
    ["running", null, 1],
    ["waiting", "ready", null],
    ["waiting", "ready", null],
    ["running", null, 1],
  ]);
  await second.authority.close();
});
