import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type InstrumentationEvent } from "solid-objects";
import { fastTiming, openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  burst,
  droppedRuns,
  openRows,
  silent,
  timerTurns,
} from "./delivery-burst-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

after(removeTemporaryDirectories);

await test("CLV-053 a burst of 1 000 withheld deliveries gives a 20 ms timer of the process a turn at least each 500 ms", async () => {
  const events: InstrumentationEvent[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: silent,
    clock: () => noon,
    timing: fastTiming,
    instrumentation: (event) => {
      events.push(event);
    },
  });
  await droppedRuns(authority, 1_000);
  const failures: string[] = [];
  const timer = await timerTurns(async () => {
    failures.push(...(await burst(authority, { events })));
  });
  assert.deepEqual(failures, []);
  assert.equal(await openRows(authority), 0);
  assert.ok(timer.turns > 20, String(timer.turns));
  assert.ok(timer.largestGap < testMilliseconds(500), String(timer.largestGap));
  await authority.close();
});
