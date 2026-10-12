import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  executePinned,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

const start = storedGate[0] ?? {};
const lost = "solid_objects.activation.lost";
const offsets = [0, 1, 2, 3, 4, 5];

type Receipt = Awaited<ReturnType<Authority["execute"]>>;

function admissions(authority: Authority): () => Promise<Receipt> {
  let made = 0;
  return () => {
    made += 1;
    const runId = `run-${String(made).padStart(4, "0")}`;
    return executePinned(authority, {
      ...start,
      runId,
      commandId: `c-admit-${runId}`,
    });
  };
}

async function scanned(authority: Authority): Promise<readonly string[]> {
  const admit = admissions(authority);
  const later = async (reads: number): Promise<Receipt> => {
    for (let read = 0; read < reads; read += 1) await authority.state();
    return admit();
  };
  const kinds: string[] = [];
  for (const reads of offsets) {
    const two = await Promise.all([admit(), later(reads)]);
    const three = await Promise.all([admit(), later(reads), later(2 * reads)]);
    kinds.push(...[...two, ...three].map((receipt) => receipt.kind));
  }
  return kinds;
}

await test("CLV-052 two and three commands at one time with no delivery lose no activation at each offset of the scan", async () => {
  const events: string[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    timing: fastTiming,
    instrumentation: (event) => {
      events.push(event.name);
    },
  });
  const kinds = await scanned(authority);
  assert.equal(kinds.length, 5 * offsets.length);
  assert.deepEqual([...new Set(kinds)], ["accepted"]);
  assert.deepEqual(
    events.filter((name) => name === lost),
    [],
  );
  assert.equal((await authority.state()).sequence, kinds.length);
  await authority.close();
});
