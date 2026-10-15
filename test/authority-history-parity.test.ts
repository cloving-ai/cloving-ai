import assert from "node:assert/strict";
import { test } from "node:test";
import { rebuildHistory } from "../src/authority/history.ts";
import { emptyAuthority } from "../src/authority/reducer.ts";
import { eventTypes } from "../src/authority/transitions.ts";
import { restore } from "../src/broker/authority-restore.ts";
import { generatedHistory } from "./authority-history-generated.ts";
import { referenceHistory } from "./authority-history-reference.ts";
import { historySnapshot } from "./authority-opening-fixture.ts";

function outcome(rebuild: () => unknown): unknown {
  try {
    return rebuild();
  } catch (error) {
    return String(error);
  }
}

await test("CLV-048 generated histories retain the full reducer state and invalid-history detail", () => {
  const covered = new Set<string>();
  const empty = structuredClone(emptyAuthority);
  for (let seed = 1; seed <= 100; seed += 1) {
    const events = generatedHistory(seed);
    for (const event of events) covered.add(event.type);
    Object.freeze(events);
    for (const event of events) {
      Object.freeze(event.payload);
      Object.freeze(event);
    }
    assert.ok(events.length > 0);
    const middle = Math.floor(events.length / 2);
    const variants = [
      events,
      events.slice(1),
      [...events, events[0]],
      events.map((event, index) =>
        index === middle ? { ...event, runId: "changed" } : event,
      ),
      events.map((event, index) =>
        index === middle ? { ...event, sequence: 0 } : event,
      ),
      events.map((event, index) =>
        index === middle ? { ...event, payload: null } : event,
      ),
    ];
    for (const history of variants)
      assert.deepEqual(
        outcome(() => rebuildHistory(history)),
        outcome(() => referenceHistory(history)),
        `seed ${String(seed)}`,
      );
  }
  assert.deepEqual([...covered].sort(), [...eventTypes].sort());
  assert.deepEqual(emptyAuthority, empty);
});

await test("CLV-048 generated snapshots preserve projection and history refusals at every position", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const events = generatedHistory(seed);
    const history = referenceHistory(events);
    const snapshot = historySnapshot({ history, events });
    const restored = restore(snapshot);
    assert.equal(restored.kind, "restored", JSON.stringify(restored));
    assert.deepEqual(restored.state, history.state);
    for (const [index] of snapshot.runs.entries()) {
      const changed = snapshot.runs.map((run, position) =>
        position === index ? { ...run, sequence: 0 } : run,
      );
      assert.deepEqual(restore({ ...snapshot, runs: changed }), {
        kind: "refused",
        reason: "projection-mismatch",
        detail: "run-sequences",
      });
    }
    for (const [index] of snapshot.outbox.entries()) {
      const changed = snapshot.outbox.map((row, position) =>
        position === index ? { ...row, createdSequence: 0 } : row,
      );
      assert.deepEqual(restore({ ...snapshot, outbox: changed }), {
        kind: "refused",
        reason: "projection-mismatch",
        detail: "outbox",
      });
    }
  }
});
