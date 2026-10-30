import assert from "node:assert/strict";
import { mkdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { testMilliseconds } from "./test-timing.ts";
import { contentionMilliseconds } from "../src/broker/actor/authority-connection.ts";
import {
  openedAuthority,
  quickCleanupTiming,
} from "./authority-actor-fixture.ts";
import {
  queryDatabase,
  removeTemporaryDirectories,
  temporaryDirectory,
  withChild,
  withChildren,
} from "./authority-store-fixture.ts";

await test("CLV-042 a missing state directory is refused as a storage failure", async () => {
  const directory = join(await temporaryDirectory(), "missing");
  const opening = await openAuthority(directory);
  assert.equal(opening.kind, "refused");
  assert.equal(opening.reason, "storage-failure");
  assert.match(opening.detail, /ENOENT/);
});

await test("CLV-042 a second process and a directory alias are refused within the contention bound while an authority holds the state directory", async () => {
  const directory = await temporaryDirectory();
  const alias = join(await temporaryDirectory(), "alias");
  await symlink(directory, alias);
  await withChild(
    { script: "authority-actor-child.ts", parameters: [directory, "commit"] },
    async (holder) => {
      await holder.waitFor("awaiting-dispatch");
      for (const path of [directory, alias]) {
        const started = performance.now();
        assert.deepEqual(await openAuthority(path), {
          kind: "refused",
          reason: "authority-held",
          detail: "database is locked",
        });
        const waited = performance.now() - started;
        assert.ok(
          waited >= contentionMilliseconds && waited < testMilliseconds(1500),
          String(waited),
        );
      }
      assert.deepEqual(await holder.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  const authority = await openedAuthority(alias, {
    timing: quickCleanupTiming,
  });
  assert.equal((await authority.state()).sequence, 1);
  await authority.close();
});

await test("CLV-042 concurrent first openings of a new state directory admit exactly one authority", async () => {
  const directory = await temporaryDirectory();
  await withChildren(
    {
      script: "authority-actor-child.ts",
      parameters: [directory, "open"],
      count: 3,
    },
    async (children) => {
      await Promise.all(children.map((child) => child.waitFor("ready")));
      for (const child of children) child.send("go\n");
      const outcomes = await Promise.all(
        children.map(async (child) => (await child.waitForLines(2))[1]),
      );
      assert.deepEqual(outcomes.sort(), [
        "opened",
        "refused authority-held",
        "refused authority-held",
      ]);
    },
  );
});

await test("CLV-042 the adapter connection runs with WAL, full synchronization, foreign keys, an exclusive lock and the contention bound", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  assert.deepEqual(await authority.settings(), {
    schemaVersion: 6,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    lockingMode: "exclusive",
    busyTimeoutMilliseconds: contentionMilliseconds,
  });
  await authority.close();
});

await test("CLV-042 the authority actor keeps one persisted opaque identity across reopening and a moved state directory", async () => {
  const parent = await temporaryDirectory();
  const directory = join(parent, "state");
  const moved = join(parent, "moved");
  await mkdir(directory);
  await (await openedAuthority(directory)).close();
  const identity = queryDatabase(
    directory,
    "SELECT actor_id FROM authority_identity",
  );
  await rename(directory, moved);
  await (await openedAuthority(moved)).close();
  assert.deepEqual(
    queryDatabase(moved, "SELECT actor_id FROM authority_identity"),
    identity,
  );
  assert.deepEqual(
    queryDatabase(
      moved,
      "SELECT actor_id FROM solid_instances WHERE actor_type = 'ClovingAuthority'",
    ),
    identity,
  );
  assert.match(
    String(Reflect.get(Object(identity[0]), "actor_id")),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

after(removeTemporaryDirectories);
