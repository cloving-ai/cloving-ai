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

const effect = (
  type: string,
  timed: {
    readonly second: number;
    readonly operation: readonly [string, number];
    readonly outcome?: string;
  },
): Record<string, unknown> => {
  const { second, operation, outcome } = timed;
  const [name, round] = operation;
  const scope = ["cloving-operation", round, "run-1", "work", name, null, null];
  return {
    ...event(type, second),
    payload: { operationId: JSON.stringify(scope), outcome },
  };
};
const step = (
  operation: readonly [string, number],
  seconds: readonly [number, number],
): Record<string, unknown>[] => [
  effect("effect.requested", { second: seconds[0], operation }),
  effect("lease.granted", { second: seconds[0], operation }),
  effect("effect.reported", { second: seconds[1], operation }),
];
const issued = (events: readonly unknown[]): readonly string[] =>
  phasesOf(events, "develop-issue").map(
    (phase) => `${phase.name}: ${phase.state}`,
  );
const opened = [
  ...begun,
  ...step(["github-prepare", 1], [2, 3]),
  ...step(["claude-turn", 1], [4, 10]),
  ...step(["github-open-pr", 1], [11, 12]),
];
const reviewing = [
  ...opened,
  effect("effect.requested", {
    second: 13,
    operation: ["github-wait-review", 1],
  }),
];

await test("CLV-065 the watch phases give a develop-issue run the steps of its pull request from the effects of each operation, with no review step of the operator", () => {
  const merged = [
    ...opened,
    ...step(["github-wait-review", 1], [13, 20]),
    ...step(["github-merge", 1], [21, 22]),
    event("run.completed", 23),
  ];
  assert.deepEqual(issued(merged), [
    "Admitted: done",
    "Started: done",
    "Work tree: done",
    "Claude turn: done",
    "Pull request: done",
    "Greptile review: done",
    "Merge: done",
    "Completed: done",
  ]);
  assert.deepEqual(phasesOf(merged, "develop-issue").slice(2, 7), [
    { name: "Work tree", state: "done", startedAt: at(2), endedAt: at(3) },
    { name: "Claude turn", state: "done", startedAt: at(4), endedAt: at(10) },
    { name: "Pull request", state: "done", startedAt: at(11), endedAt: at(12) },
    {
      name: "Greptile review",
      state: "done",
      startedAt: at(13),
      endedAt: at(20),
    },
    { name: "Merge", state: "done", startedAt: at(21), endedAt: at(22) },
  ]);
});

await test("CLV-065 the watch phases show the Greptile review of a develop-issue run as active while it waits, and give the Claude turn of two rounds the time from the first request to the last report", () => {
  const broken = ["not json", "5"].map((operationId) => ({
    ...event("effect.requested", 2),
    payload: { operationId },
  }));
  assert.deepEqual(issued([...begun, ...broken]).slice(2, 4), [
    "Work tree: active",
    "Claude turn: pending",
  ]);
  assert.deepEqual(issued(reviewing).slice(5), [
    "Greptile review: active",
    "Merge: pending",
    "Completed: pending",
  ]);
  const fixed = [
    ...reviewing,
    effect("effect.reported", {
      second: 20,
      operation: ["github-wait-review", 1],
    }),
    effect("effect.requested", { second: 21, operation: ["claude-turn", 2] }),
  ];
  assert.deepEqual(issued(fixed).slice(3, 5), [
    "Claude turn: active",
    "Pull request: done",
  ]);
  const twice = [
    ...fixed,
    effect("effect.reported", { second: 30, operation: ["claude-turn", 2] }),
    ...step(["github-open-pr", 2], [31, 32]),
  ];
  assert.deepEqual(phasesOf(twice, "develop-issue")[3], {
    name: "Claude turn",
    state: "done",
    startedAt: at(4),
    endedAt: at(30),
  });
  assert.deepEqual(issued([...twice, event("run.failed", 33)]).slice(5), [
    "Greptile review: done",
    "Merge: pending",
    "Failed: failed",
  ]);
});

await test("CLV-065 the watch phases show a step of a develop-issue run as failed when the last report of its operation failed or stopped, and as active at a new request of the operation", () => {
  const operation = ["github-open-pr", 1] as const;
  const reported = (outcome: string): Record<string, unknown>[] => [
    ...opened.slice(0, -1),
    effect("effect.reported", { second: 12, operation, outcome }),
  ];
  assert.deepEqual(issued(reported("failed")).slice(3, 6), [
    "Claude turn: done",
    "Pull request: failed",
    "Greptile review: pending",
  ]);
  assert.deepEqual(
    issued([...reported("stopped"), event("run.failed", 13)]).slice(4),
    [
      "Pull request: failed",
      "Greptile review: pending",
      "Merge: pending",
      "Failed: failed",
    ],
  );
  const again = effect("effect.requested", { second: 14, operation });
  assert.deepEqual(issued([...reported("failed"), again]).slice(4, 6), [
    "Pull request: active",
    "Greptile review: pending",
  ]);
  assert.deepEqual(issued(reported("completed")).slice(4, 6), [
    "Pull request: done",
    "Greptile review: active",
  ]);
});
