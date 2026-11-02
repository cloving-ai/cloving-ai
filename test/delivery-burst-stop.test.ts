import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type InstrumentationEvent } from "solid-objects";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  activationEvent,
  burst,
  burstTiming,
  droppedRuns,
  instrumentationWithStop,
  lostEvent,
  lostReport,
  openRows,
  silent,
} from "./delivery-burst-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

after(removeTemporaryDirectories);

await test("CLV-051 a stop of the process just after a claim in the burst loses no activation", async () => {
  const events: InstrumentationEvent[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: silent,
    clock: () => noon,
    timing: burstTiming,
    instrumentation: instrumentationWithStop(events, {
      activation: 300,
      milliseconds: testMilliseconds(400),
    }),
  });
  await droppedRuns(authority, 1_000);
  assert.deepEqual(await burst(authority, { events }), []);
  const activations = events.filter(
    (event) => event.name === activationEvent,
  ).length;
  assert.ok(activations > 300, String(activations));
  assert.deepEqual(
    events
      .filter((event) => event.name === lostEvent)
      .map((event) => event.name),
    [],
    lostReport(events),
  );
  assert.equal(await openRows(authority), 0);
  await authority.close();
});
