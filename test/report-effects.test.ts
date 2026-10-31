import assert from "node:assert/strict";
import { test } from "node:test";
import { reportFixRounds, reportPhaseTimes } from "../src/report-effects.ts";
import { effectEvents } from "./report-fixture.ts";

const at = Date.parse("2026-10-24T12:00:00Z");

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
          result: "not-json",
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
