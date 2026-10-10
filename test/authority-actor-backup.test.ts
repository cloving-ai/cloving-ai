import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  deliverUntil,
  executePinned,
  externalService,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const started = storedGate[1] ?? {};
const identity = "SELECT actor_id FROM authority_identity";

await test("CLV-042 a backup taken while the authority is open holds the library and domain tables at one commit, holds no World files, and opens as the same authority without a second send", async () => {
  const directory = await temporaryDirectory();
  const service = externalService();
  const options = { ...service.options, timing: fastTiming };
  const authority = await openedAuthority(directory, options);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  await deliverUntil(
    authority,
    async () => (await authority.eligibleIntents()).length === 0,
  );
  const backupDirectory = await temporaryDirectory();
  const target = join(backupDirectory, "authority.sqlite");
  await authority.backup(target);
  await assert.rejects(authority.backup(target), /backup-failed/);
  assert.equal((await executePinned(authority, started)).kind, "accepted");
  await authority.close();
  assert.deepEqual(await readdir(backupDirectory), ["authority.sqlite"]);
  const restored = await openedAuthority(backupDirectory, options);
  assert.equal((await restored.state()).sequence, 2);
  assert.deepEqual(
    (await restored.events()).map((event) => event.type),
    ["run.created", "step.dispatched"],
  );
  assert.deepEqual(
    (await restored.operations()).map((operation) =>
      operation.deliveries.map((delivery) => delivery.outcome),
    ),
    [["sent"]],
  );
  await deliverUntil(restored, async () =>
    Promise.resolve(service.sent.length === 1),
  );
  await restored.close();
  assert.deepEqual(
    queryDatabase(backupDirectory, identity),
    queryDatabase(directory, identity),
  );
  assert.equal(service.sent.length, 1);
});

after(removeTemporaryDirectories);
