import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { Actor, createRuntime, type InstrumentationEvent } from "solid-objects";
import { sqlite } from "solid-objects/database/sqlite";
import { librarySettings } from "../src/broker/actor/authority-settings.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  burst,
  burstTiming,
  droppedRuns,
  openRows,
  silent,
  timerTurns,
} from "./delivery-burst-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

after(removeTemporaryDirectories);

await test("CLV-053 queued slow turns yield before the timer fairness bound", async () => {
  const turnMilliseconds = 20;
  const fairnessBound = testMilliseconds(500);
  const queuedTurns = Math.ceil((fairnessBound * 1.6) / turnMilliseconds);
  class Busy extends Actor {
    static override readonly actorType = "Busy";

    turn(): void {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        turnMilliseconds,
      );
    }
  }
  const database = sqlite({
    path: join(await temporaryDirectory(), "queued.sqlite"),
  });
  const runtime = createRuntime({
    database,
    ...librarySettings(burstTiming, () => undefined),
  });
  const worker = runtime.worker();
  runtime.register(Busy);
  try {
    await runtime.install();
    for (let turn = 0; turn < queuedTurns; turn += 1)
      await runtime.enqueueInternalMessage({
        actorType: Busy.actorType,
        actorId: "busy",
        operation: "turn",
      });
    let processed = 0;
    const timer = await timerTurns(async () => {
      processed = await worker.runUntilIdle();
    });
    assert.equal(processed, queuedTurns);
    assert.ok(timer.largestGap < fairnessBound, JSON.stringify(timer));
  } finally {
    await worker.stop();
    await runtime.close();
    await database.close();
  }
});

await test("CLV-053 burst readiness does not repeatedly load full authority projections", async () => {
  const events: InstrumentationEvent[] = [];
  const authority = await openedAuthority(await temporaryDirectory(), {
    delivery: silent,
    clock: () => noon,
    timing: burstTiming,
    instrumentation: (event) => {
      events.push(event);
    },
  });
  try {
    await droppedRuns(authority, 1);
    let snapshots = 0;
    const observed = {
      ...authority,
      operations: () => {
        snapshots += 1;
        return authority.operations();
      },
    };
    assert.deepEqual(await burst(observed, { events, expected: 1 }), []);
    assert.equal(snapshots, 0);
    assert.equal(await openRows(authority), 0);
  } finally {
    await authority.close();
  }
});
