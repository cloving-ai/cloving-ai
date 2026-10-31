import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reportEffectData,
  reportFixRounds,
  reportPhaseTimes,
} from "../src/report-effects.ts";
import { effectEvents } from "./report-fixture.ts";
import { loopReport } from "../src/report.ts";
import { fields } from "./service-fixture.ts";

const at = Date.parse("2026-10-24T12:00:00Z");

await test("CLV-243 non-string run IDs make effect history unavailable", () => {
  const events = [
    ...effectEvents("run", { method: "open-pr", sequence: 1, at }),
    ...effectEvents("run", { method: "run-turn", sequence: 3, at }),
    ...effectEvents("run", {
      method: "merge",
      sequence: 5,
      at,
      result: { merged: true, number: 8 },
    }),
  ];
  for (const runId of [undefined, null, 7, true, {}, []])
    assert.deepEqual(
      reportEffectData(events.map((event) => ({ ...event, runId }))),
      { fixRounds: null, workerTurn: null, codeReview: null, merge: null },
    );
});

await test("CLV-243 a merged pull request with no opening effect has unknown fix rounds", () => {
  const data = reportFixRounds(
    effectEvents("missing-open", {
      method: "merge",
      sequence: 1,
      at,
      result: { merged: true, number: 8 },
    }),
  );
  assert.equal(data?.length, 1);
  assert.equal(data[0]?.value, null);
  assert.equal(data[0].evidence["pullRequest"], 8);
  assert.equal(data[0].evidence["fixRounds"], null);
});

await test("CLV-243 merge evidence falls back to the requested pull request number", () => {
  const data = reportFixRounds([
    ...effectEvents("run", { method: "open-pr", sequence: 1, at }),
    ...effectEvents("run", {
      method: "merge",
      sequence: 3,
      at,
      payload: { number: 8 },
      result: { merged: true },
    }),
  ]);
  assert.equal(data?.[0]?.value, 0);
  assert.equal(data[0].evidence["pullRequest"], 8);
});

await test("CLV-243 negative phase durations and unreadable effect sources stay unknown", () => {
  const data = reportPhaseTimes(
    effectEvents("run", {
      method: "run-turn",
      sequence: 1,
      at,
      minutes: -1,
    }),
    "run-turn",
  );
  assert.equal(data?.[0]?.value, null);
  assert.deepEqual(data[0].evidence, { runId: "run", operationId: "run-1" });
  assert.equal(reportFixRounds(null), null);
  assert.equal(reportPhaseTimes(null, "run-turn"), null);
});

function historyReads(count: number): number {
  let reads = 0;
  const events = Array.from({ length: count }, (_, index) =>
    effectEvents(`run-${String(index)}`, {
      method: "run-turn",
      sequence: index * 2 + 1,
      at,
    }),
  )
    .flat()
    .map(
      (event) =>
        new Proxy(event, {
          get(target, property) {
            if (property === "runId") reads += 1;
            const value: unknown = Reflect.get(target, property);
            return value;
          },
        }),
    );
  const report = loopReport({
    now: at + 3_600_000,
    since: 1,
    completions: [],
    effects: events,
  });
  assert.equal(
    fields(fields(report.metrics)["phases.workerTurn.medianMinutes"])["value"],
    1,
  );
  return reads;
}

await test("CLV-243 doubling effect history keeps report event reads linear", () => {
  const small = historyReads(128);
  const large = historyReads(256);
  assert.ok(
    large <= small * 3,
    `${String(small)} reads grew to ${String(large)}`,
  );
});

await test("CLV-243 fix rounds accept the daemon merge commit result and count each requested operation once", () => {
  const opened = effectEvents("run", {
    method: "open-pr",
    sequence: 1,
    at,
    result: { number: 8 },
  });
  const turns = effectEvents("run", { method: "run-turn", sequence: 3, at });
  const merged = effectEvents("run", {
    method: "merge",
    sequence: 6,
    at,
    payload: { number: 8 },
    result: { number: 8, merged: "a".repeat(40) },
  });
  const data = reportFixRounds([
    ...opened,
    ...turns,
    { ...turns[0], sequence: 5 },
    ...merged,
  ]);
  assert.equal(data?.length, 1);
  assert.equal(data[0]?.value, 1);
  assert.equal(data[0].evidence["pullRequest"], 8);
});

await test("CLV-243 unreadable effect results cannot hide a merged pull request behind readable samples", () => {
  const opened = effectEvents("run", { method: "open-pr", sequence: 1, at });
  const good = effectEvents("run", {
    method: "merge",
    sequence: 3,
    at,
    result: { merged: true, number: 8 },
  });
  const bad = effectEvents("other", { method: "merge", sequence: 5, at });
  for (const result of ["not-json", "null"])
    assert.equal(
      reportFixRounds([
        ...opened,
        ...good,
        ...bad.slice(0, 1),
        {
          ...bad[1],
          payload: {
            operationId: "other-5",
            outcome: "completed",
            result,
          },
        },
      ]),
      null,
    );
});

await test("CLV-243 missing effect requests make phase history unavailable instead of dropping an ended operation", () => {
  const good = effectEvents("run", { method: "run-turn", sequence: 1, at });
  const missing = effectEvents("other", {
    method: "run-turn",
    sequence: 3,
    at,
  });
  assert.equal(
    reportPhaseTimes([...good, ...missing.slice(1)], "run-turn"),
    null,
  );
});
