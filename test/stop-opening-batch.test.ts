import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deliverUntil, openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  accepting,
  closedRows,
  droppedAtTheBound,
  empty,
  steady,
  unreachable,
} from "./stop-opening-fixture.ts";

after(removeTemporaryDirectories);

const many = Array.from(
  { length: 101 },
  (_, index) => `run-${String(index).padStart(3, "0")}`,
);
const last = "run-zzz";

const scenes = [
  {
    name: "each run with a failed start gets a reconciliation",
    runs: many,
    first: unreachable,
    second: empty,
    bounded: many.length,
    calls: many.map((runId) => `reconcile ${runId}`),
  },
  {
    name: "each run with a sent start gets a stop request when the adapter has a stop function",
    runs: many,
    first: () => accepting({ stop: { kind: "unknown" }, failing: [] }),
    second: () => accepting({ stop: { kind: "stopped" }, failing: [] }),
    bounded: many.length,
    calls: many.map((runId) => `stop ${runId}`),
  },
  {
    name: "a run with a failed start after 100 runs with a sent start and no stop function gets a reconciliation",
    runs: [...many.slice(0, 100), last],
    first: () => accepting({ failing: [last] }),
    second: empty,
    bounded: 1,
    calls: [`reconcile ${last}`],
  },
];

for (const scene of scenes)
  await test(`CLV-049 an opening gives one more attempt to each dropped run at the stop bound, also after the first 100 runs: ${scene.name}`, async () => {
    const directory = await temporaryDirectory();
    const failing = await openedAuthority(directory, {
      ...steady,
      delivery: scene.first().delivery,
    });
    await droppedAtTheBound(failing, scene);
    await failing.close();
    const destination = scene.second();
    const authority = await openedAuthority(directory, {
      ...steady,
      delivery: destination.delivery,
    });
    await deliverUntil(
      authority,
      async () => (await closedRows(authority, 3)) === scene.bounded,
    );
    assert.deepEqual([...destination.calls].sort(), scene.calls);
    assert.equal(
      (await authority.effects.closure(scene.runs.at(-1) ?? "")).closure,
      "cancelled",
    );
    await authority.close();
  });
