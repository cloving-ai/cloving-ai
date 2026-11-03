import assert from "node:assert/strict";
import { after, test } from "node:test";
import { externalService, openedAuthority } from "./authority-actor-fixture.ts";
import {
  admittedBatch,
  fullReads,
  memoryReads,
  preparedDuring,
  rebuiltReads,
  scriptedSeries,
} from "./authority-memory-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

await test("CLV-276 after the start, the state, eligible intents, operations, pinned resumption, run sequences and workflow IDs read no projected table in full", async () => {
  const directory = await temporaryDirectory();
  const authority = await openedAuthority(directory, externalService().options);
  try {
    await scriptedSeries(authority);
    const statements = await preparedDuring(() => memoryReads(authority));
    assert.deepEqual(fullReads(statements), []);
  } finally {
    await authority.close();
  }
});

await test("CLV-276 after a scripted series of runs, decisions, effects, deliveries and cancellations, the reads from memory equal a rebuild from the tables, also after an authority restore", async () => {
  const directory = await temporaryDirectory();
  const options = externalService().options;
  const authority = await openedAuthority(directory, options);
  let remembered: unknown;
  try {
    await scriptedSeries(authority);
    remembered = await memoryReads(authority);
  } finally {
    await authority.close();
  }
  assert.deepEqual(remembered, await rebuiltReads(directory));
  const restored = await openedAuthority(directory, options);
  let restoredReads: unknown;
  try {
    restoredReads = await memoryReads(restored);
  } finally {
    await restored.close();
  }
  assert.deepEqual(restoredReads, await rebuiltReads(directory));
});

await test("CLV-276 the first read after a batch of 200 admissions with no read between them equals a rebuild from the tables, and prepares the statements of a read after one admission", async () => {
  const directory = await temporaryDirectory();
  const options = externalService().options;
  const authority = await openedAuthority(directory, options);
  const batch = Array.from(
    { length: 200 },
    (_, index) => `run-${String(index + 2)}`,
  );
  let remembered: unknown;
  try {
    await admittedBatch(authority, ["run-1"]);
    const single = await preparedDuring(() => authority.state());
    await admittedBatch(authority, batch);
    assert.deepEqual(await preparedDuring(() => authority.state()), single);
    remembered = await memoryReads(authority);
  } finally {
    await authority.close();
  }
  assert.deepEqual(remembered, await rebuiltReads(directory));
});

after(removeTemporaryDirectories);
