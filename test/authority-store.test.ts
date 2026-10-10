import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { answeredGate, continuation, recorded } from "./authority-fixture.ts";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { contentionMilliseconds } from "../src/broker/actor/authority-connection.ts";
import {
  opened,
  removeTemporaryDirectories,
  temporaryDirectory,
  withChild,
  withChildren,
} from "./authority-store-fixture.ts";

await test("CLV-007 a process killed after committing an answer reopens with the answer and exactly one eligible continuation", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "authority-crash-child.ts", parameters: [directory] },
    async (child) => {
      await child.waitFor("awaiting-dispatch");
      assert.deepEqual(await child.kill(), { code: null, signal: "SIGKILL" });
      assert.deepEqual(child.lines, [
        'receipt {"kind":"accepted","sequence":1,"intents":[{"kind":"start-run","runId":"run-1","operationId":"[\\"cloving-operation\\",0,\\"run-1\\",\\"admission\\",\\"start-run\\",null,null]"}]}',
        'receipt {"kind":"accepted","sequence":2,"intents":[]}',
        'receipt {"kind":"accepted","sequence":3,"intents":[]}',
        `receipt ${JSON.stringify({ kind: "accepted", sequence: 4, intents: [continuation] })}`,
        "awaiting-dispatch",
      ]);
    },
  );
  const wal = await readFile(join(directory, "authority.sqlite-wal"));
  assert.ok(wal.length > 32);
  assert.ok([0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0)));

  const { store } = await opened(directory);
  assert.equal((await store.state()).sequence, 4);
  assert.equal((await store.state()).runs["run-1"]?.status, "running");
  assert.deepEqual(
    (await store.events()).map((event) => [event.sequence, event.type]),
    [
      [1, "run.created"],
      [2, "run.started"],
      [3, "gate.opened"],
      [4, "gate.decided"],
    ],
  );
  assert.deepEqual((await store.events()).at(-1)?.payload, {
    gateId: "gate-1",
    decision: "approved",
  });
  assert.deepEqual(await store.eligibleIntents(), [continuation]);
  assert.deepEqual(await store.execute(answeredGate.at(-1), recorded), {
    kind: "duplicate",
    sequence: 4,
    intents: [continuation],
  });
  assert.deepEqual(await store.eligibleIntents(), [continuation]);
  await store.close();
});

await test("CLV-007 a second authority process for the same state directory is refused within the contention bound", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "authority-crash-child.ts", parameters: [directory] },
    async (holder) => {
      await holder.waitFor("awaiting-dispatch");
      const started = performance.now();
      assert.deepEqual(await openAuthority(directory), {
        kind: "refused",
        reason: "authority-held",
        detail: "database is locked",
      });
      const waited = performance.now() - started;
      assert.ok(
        waited >= contentionMilliseconds && waited < 1500,
        String(waited),
      );
      assert.deepEqual(await holder.kill(), { code: null, signal: "SIGKILL" });
    },
  );
  const { store } = await opened(directory);
  assert.equal((await store.state()).sequence, 4);
  await store.close();
});

await test("CLV-007 concurrent first opens of a new state directory admit exactly one authority", async () => {
  const directory = await temporaryDirectory();
  await withChildren(
    { script: "authority-open-child.ts", parameters: [directory], count: 3 },
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
  const { store } = await opened(directory);
  assert.equal((await store.settings()).journalMode, "wal");
  await store.close();
});

after(removeTemporaryDirectories);
