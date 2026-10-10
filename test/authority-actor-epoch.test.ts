import assert from "node:assert/strict";
import { after, test } from "node:test";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import { recorded } from "./authority-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

const admission = storedGate[0] ?? {};
const started = storedGate[1] ?? {};

await test("CLV-042 each opening of the same state directory allocates a new authority epoch", async () => {
  const directory = await temporaryDirectory();
  const epochs: number[] = [];
  for (let opening = 0; opening < 3; opening += 1) {
    const authority = await openedAuthority(directory);
    epochs.push(authority.epoch);
    await authority.close();
  }
  assert.deepEqual(epochs, [1, 2, 3]);
});

await test("CLV-042 a result command from an older authority epoch is rejected and does not advance authority", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  assert.equal((await executePinned(first, admission)).kind, "accepted");
  const older = first.epoch;
  await first.close();
  const second = await openedAuthority(directory);
  assert.deepEqual(
    await second.execute(started, { ...recorded, epoch: older }),
    { kind: "rejected", reason: "stale-epoch" },
  );
  assert.equal((await second.state()).sequence, 1);
  assert.equal((await second.state()).runs["run-1"]?.status, "queued");
  assert.deepEqual(
    await second.execute(started, { ...recorded, epoch: second.epoch }),
    { kind: "accepted", sequence: 2, intents: [] },
  );
  await second.close();
});

await test("CLV-042 a result command committed in an older epoch returns its stored receipt after a restart", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  assert.equal((await executePinned(first, admission)).kind, "accepted");
  const context = { ...recorded, epoch: first.epoch };
  assert.equal((await first.execute(started, context)).kind, "accepted");
  await first.close();
  const second = await openedAuthority(directory);
  assert.deepEqual(await second.execute(started, context), {
    kind: "duplicate",
    sequence: 2,
    intents: [],
  });
  await second.close();
});

after(removeTemporaryDirectories);
