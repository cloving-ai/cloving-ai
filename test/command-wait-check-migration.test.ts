import assert from "node:assert/strict";
import { after, test } from "node:test";
import { commandWaitSchema } from "../src/storage/command-wait-rows.ts";
import { currentVersion } from "../src/storage/domain-schema.ts";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { context, opening, waitStore } from "./command-wait-fixture.ts";
import {
  alterDatabase,
  opened,
  queryDatabase,
  removeTemporaryDirectories,
} from "./authority-store-fixture.ts";
import { key, checkRequest } from "./command-wait-check-fixture.ts";

after(removeTemporaryDirectories);

async function versionFive() {
  const { store, directory } = await waitStore();
  assert.equal((await store.execute(opening, context)).kind, "accepted");
  const before = await store.state();
  await store.close();
  alterDatabase(
    directory,
    `
    ALTER TABLE command_waits RENAME TO previous_waits;
    ${commandWaitSchema}
    INSERT INTO command_waits SELECT run_id, name, command, input_digest, maximum_wait_seconds, poll_every_seconds, started_at, deadline, next_check_at, state, settled_at, reason FROM previous_waits;
    DROP TABLE previous_waits;
    DELETE FROM schema_migrations WHERE version > 5;
    PRAGMA user_version = 5;
  `,
  );
  return { directory, before };
}

await test("CLV-236 version 5 gains durable check state without renewing its existing wait", async () => {
  const { directory, before } = await versionFive();
  const checksums = queryDatabase(
    directory,
    "SELECT * FROM schema_migrations ORDER BY version",
  );
  const { store } = await opened(directory);
  try {
    assert.equal((await store.settings()).schemaVersion, 6);
    assert.equal(currentVersion, 6);
    assert.deepEqual(await store.state(), before);
    const receipt = await store.execute(checkRequest, {
      ...context,
      epoch: store.epoch,
    });
    assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
    assert.equal((await store.state()).commandWaits?.[key]?.checkCount, 1);
  } finally {
    await store.close();
  }
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT * FROM schema_migrations WHERE version <= 5 ORDER BY version",
    ),
    checksums,
  );
  const reopened = (await opened(directory)).store;
  try {
    assert.equal((await reopened.state()).commandWaits?.[key]?.checkCount, 1);
    assert.equal(
      (await reopened.state()).commandWaits?.[key]?.deadline,
      before.commandWaits?.[key]?.deadline,
    );
  } finally {
    await reopened.close();
  }
});

await test("CLV-236 a failed check-state migration rolls back and can be retried", async () => {
  const { directory, before } = await versionFive();
  alterDatabase(
    directory,
    `CREATE TRIGGER fail_check_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 6 BEGIN SELECT RAISE(ABORT, 'injected-check-migration'); END;`,
  );
  const refused = await openAuthority(directory);
  assert.equal(refused.kind, "refused");
  assert.match(refused.detail, /injected-check-migration/);
  assert.deepEqual(queryDatabase(directory, "PRAGMA user_version"), [
    { user_version: 5 },
  ]);
  alterDatabase(directory, "DROP TRIGGER fail_check_migration;");
  const { store } = await opened(directory);
  try {
    assert.deepEqual(await store.state(), before);
  } finally {
    await store.close();
  }
});
