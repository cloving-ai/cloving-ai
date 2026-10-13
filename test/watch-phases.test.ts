import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionOf, phasesOf } from "../src/cli/watch-phases.ts";

const at = (second: number): string =>
  `2026-10-13T21:26:${String(second).padStart(2, "0")}.000Z`;
const event = (type: string, second: number): Record<string, unknown> => ({
  type,
  recordedAt: at(second),
});
const begun = [event("run.created", 0), event("run.started", 1)];
const turned = [
  ...begun,
  event("effect.requested", 2),
  event("lease.granted", 2),
  event("effect.reported", 30),
];
const asked = [...turned, event("gate.opened", 31)];

function states(events: readonly unknown[]): readonly string[] {
  return phasesOf(events).map((phase) => `${phase.name}: ${phase.state}`);
}

await test("CLV-016 the watch phases give a run five steps from its events, with one active step and the time span of each step", () => {
  assert.deepEqual(states([event("run.created", 0)]), [
    "Admitted: done",
    "Started: active",
    "Claude turn: pending",
    "Your review: pending",
    "Completed: pending",
  ]);
  assert.deepEqual(states([...begun, event("effect.requested", 2)]), [
    "Admitted: done",
    "Started: done",
    "Claude turn: active",
    "Your review: pending",
    "Completed: pending",
  ]);
  assert.deepEqual(phasesOf(asked), [
    { name: "Admitted", state: "done", startedAt: at(0), endedAt: at(0) },
    { name: "Started", state: "done", startedAt: at(1), endedAt: at(1) },
    { name: "Claude turn", state: "done", startedAt: at(2), endedAt: at(30) },
    { name: "Your review", state: "active", startedAt: at(31), endedAt: null },
    { name: "Completed", state: "pending", startedAt: null, endedAt: null },
  ]);
});

await test("CLV-016 the watch phases show the end of a run: completed, failed or dropped, and a step that did not occur stays pending", () => {
  const decided = [...asked, event("gate.decided", 40)];
  assert.deepEqual(states([...decided, event("run.completed", 41)]), [
    "Admitted: done",
    "Started: done",
    "Claude turn: done",
    "Your review: done",
    "Completed: done",
  ]);
  assert.deepEqual(states([...begun, event("run.failed", 5)]).slice(2), [
    "Claude turn: pending",
    "Your review: pending",
    "Failed: failed",
  ]);
  assert.deepEqual(states([...turned, event("run.cancelled", 35)]).slice(2), [
    "Claude turn: done",
    "Your review: pending",
    "Dropped: failed",
  ]);
  assert.deepEqual(states([]).slice(0, 1), ["Admitted: pending"]);
});

await test("CLV-016 the watch phases name the review step after its decision: approved, or denied as a step that failed, and they give the decision of a gate that is closed", () => {
  const decided = (decision: string): Record<string, unknown>[] => [
    ...asked,
    { ...event("gate.decided", 40), payload: { decision } },
    event("run.completed", 41),
  ];
  assert.deepEqual(states(decided("approved")).slice(3), [
    "Approved: done",
    "Completed: done",
  ]);
  assert.deepEqual(states(decided("denied")).slice(3), [
    "Denied: failed",
    "Completed: done",
  ]);
  assert.deepEqual(states(decided("answered")).slice(3, 4), [
    "Your review: done",
  ]);
  assert.deepEqual(
    [
      decisionOf(decided("denied")),
      decisionOf(asked),
      decisionOf([...decided("denied"), event("gate.opened", 50)]),
      decisionOf([event("gate.decided", 1), "no event"]),
    ],
    ["denied", "", "", ""],
  );
});
