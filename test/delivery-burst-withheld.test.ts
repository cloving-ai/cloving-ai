import assert from "node:assert/strict";
import { after, test } from "node:test";
import { type InstrumentationEvent } from "solid-objects";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  burst,
  burstTiming,
  droppedRuns,
  lostEvent,
  lostReport,
  openRows,
  silent,
  start,
} from "./delivery-burst-fixture.ts";
import { noon } from "./effect-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-051 a burst of 1 000 withheld deliveries with the fast test timing loses no activation, and the authority stays available", async () => {
  const events: InstrumentationEvent[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: silent,
    clock: () => noon,
    timing: burstTiming,
    instrumentation: (event) => {
      events.push(event);
    },
  });
  await droppedRuns(authority, 1_000);
  assert.equal(await openRows(authority), 1_000);
  assert.deepEqual(await burst(authority, { events }), []);
  assert.deepEqual(
    events
      .filter((event) => event.name === lostEvent)
      .map((event) => event.name),
    [],
    lostReport(events),
  );
  assert.equal(await openRows(authority), 0);
  const later = await executePinned(authority, {
    ...start,
    runId: "run-later",
    commandId: "c-later",
  });
  assert.equal(later.kind, "accepted");
  await authority.close();
});
