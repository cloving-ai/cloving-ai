import assert from "node:assert/strict";
import { after, test } from "node:test";
import { emptyAuthority } from "../src/authority/reducer.ts";
import { ownedDatabase } from "../src/broker/actor/authority-runtime.ts";
import { upgradeDecisions } from "../src/broker/decision-upgrade.ts";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import { downgrade } from "./authority-decision-fixture.ts";
import {
  alterDatabase,
  queryDatabase,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-008 a fault in the decision rows of a migration leaves version 2 with no added table and no migration record", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  for (const command of storedGate) await executePinned(first, command);
  await first.close();
  alterDatabase(directory, downgrade);
  const owned = await ownedDatabase(directory);
  assert.equal(owned.kind, "owned");
  const orphan = {
    runId: "run-absent",
    gateId: "gate-1",
    kind: "untyped",
    label: null,
    subject: null,
    prompt: null,
    expiresAt: null,
    generation: 1,
    revision: 1,
    wait: "registered",
    outcome: null,
    openedSequence: 3,
  } as const;
  await assert.rejects(
    upgradeDecisions(owned.database, {
      ...emptyAuthority,
      gates: { "run-absent gate-1": orphan },
    }),
    /FOREIGN KEY constraint failed/,
  );
  await owned.database.close();
  assert.deepEqual(queryDatabase(directory, "PRAGMA user_version"), [
    { user_version: 2 },
  ]);
  assert.deepEqual(
    queryDatabase(
      directory,
      "SELECT name FROM sqlite_schema WHERE name IN ('gates', 'run_details', 'documents')",
    ),
    [],
  );
  assert.deepEqual(
    queryDatabase(directory, "SELECT version FROM schema_migrations"),
    [{ version: 1 }, { version: 2 }],
  );
});
