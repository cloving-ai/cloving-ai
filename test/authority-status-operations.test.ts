import assert from "node:assert/strict";
import { test } from "node:test";
import { runView, type StatusInput } from "../src/authority/status.ts";
import {
  continuation,
  effect,
  input,
  sent,
  unknown,
} from "./authority-status-fixture.ts";

function reason(view: ReturnType<typeof runView>): readonly unknown[] {
  return [
    view.condition,
    view.reason.code,
    view.nextAction,
    view.humanInputCanHelp,
  ];
}

const recovering = effect({
  status: "recovering",
  reason: "outcome-unknown",
  attempts: 2,
});
const blocked = effect({
  operationId: '["cloving-operation",2,"run-1","work","effect",null,null]',
  status: "blocked",
  reason: "outcome-unknown",
  attempts: 3,
});
const pinBlocked = {
  ...sent,
  operationId: continuation,
  kind: "continue-run" as const,
  releasedSequence: null,
  outcomes: ["blocked"],
};

const cases: readonly (readonly [
  string,
  StatusInput,
  readonly [string, string, string | null, boolean],
])[] = [
  [
    "an effect with an unknown outcome that the service reconciles",
    input({ status: "running", observed: {}, effects: [recovering] }),
    ["uncertain-effect", "effect-recovering", "reconcile-effect", false],
  ],
  [
    "an effect at its recovery bound",
    input({ status: "running", observed: {}, effects: [recovering, blocked] }),
    ["uncertain-effect", "effect-blocked", "inspect-effect", true],
  ],
  [
    "an effect at its recovery bound, before a worker report and a silent period",
    input({
      status: "running",
      observed: { condition: "quota-wait", reason: "provider-quota" },
      silent: true,
      effects: [blocked],
    }),
    ["uncertain-effect", "effect-blocked", "inspect-effect", true],
  ],
  [
    "a dispatch with no known result, before an effect at its recovery bound",
    input({ status: "running", operations: [unknown], effects: [blocked] }),
    ["uncertain-effect", "delivery-outcome-unknown", "reconcile-effect", true],
  ],
  [
    "an effect that the service reconciles, before a continuation that the pin blocks",
    input({
      status: "running",
      operations: [pinBlocked],
      effects: [recovering],
    }),
    ["uncertain-effect", "effect-recovering", "reconcile-effect", false],
  ],
  [
    "a paused run with an effect at its recovery bound",
    input({ status: "paused", effects: [blocked] }),
    ["paused", "operator-pause", "resume", true],
  ],
  [
    "a run with effects in work and in a wait",
    input({
      status: "running",
      effects: [
        effect({}),
        effect({ status: "waiting", reason: "ready", leaseGeneration: null }),
        effect({ status: "completed" }),
      ],
    }),
    ["working", "in-progress", null, false],
  ],
];

for (const [title, given, expected] of cases)
  await test(`CLV-049 status gives a structured reason for: ${title}`, () => {
    assert.deepEqual(reason(runView(given)), expected);
  });

await test("CLV-049 the detail text of an uncertain effect says what the service does and when a person must examine the effect", () => {
  const texts = [recovering, blocked].map(
    (given) =>
      runView(input({ status: "running", effects: [given] })).reason.detail,
  );
  assert.deepEqual(texts, [
    "A protected effect has no known result. The service reconciles it before a new send.",
    "A protected effect has no known result and its recovery bound is reached. A person must examine the effect.",
  ]);
});

const listed: readonly (readonly [string, string, string | null])[] = [
  ["operation-2", "waiting", "ready"],
  ["operation-3", "waiting", "resource"],
  ["operation-4", "waiting", "run-not-running"],
  ["operation-5", "cancelled", "ready"],
  ["operation-6", "refused", "budget-exhausted"],
];

await test("CLV-049 status gives the budget of the run and each operation with its state, reason, lease generation, attempts and limit", () => {
  const view = runView(
    input({
      status: "running",
      budget: { limit: 5, spent: 3 },
      effects: [
        effect({ operationId: "operation-1" }),
        ...listed.map(([operationId, status, reason]) =>
          effect({
            operationId,
            status,
            reason,
            leaseGeneration: null,
            attempts: 0,
          }),
        ),
      ],
    }),
  );
  assert.deepEqual(view.budget, { limit: 5, spent: 3 });
  assert.deepEqual(view.effects[0], {
    operationId: "operation-1",
    state: "running",
    reason: null,
    leaseGeneration: 1,
    attempts: 1,
    limit: 3,
  });
  assert.deepEqual(
    view.effects
      .slice(1)
      .map((shown) => [
        shown.operationId,
        shown.state,
        shown.reason,
        shown.leaseGeneration,
        shown.attempts,
        shown.limit,
      ]),
    [
      ["operation-2", "waiting", "capacity", null, 0, 3],
      ["operation-3", "waiting", "resource", null, 0, 3],
      ["operation-4", "waiting", "run-not-running", null, 0, 3],
      ["operation-5", "cancelled", "ready", null, 0, 3],
      ["operation-6", "refused", "budget-exhausted", null, 0, 3],
    ],
  );
  const plain = runView(input({ status: "queued" }));
  assert.deepEqual([plain.budget, plain.effects], [null, []]);
});

await test("CLV-049 the recovery of a run with an uncertain effect is the largest attempt count with its limit, and the evidence names each recorded event", () => {
  const view = runView(
    input({
      status: "running",
      observed: { attempt: 1, limit: 9, evidence: "attempt-log-1" },
      effects: [
        effect({ status: "running", attempts: 7, limit: 8 }),
        recovering,
        { ...blocked, attempts: 4, limit: 4 },
        effect({ status: "recovering", attempts: 3, limit: 6 }),
      ],
      effectEvidence: [11, 14],
    }),
  );
  assert.deepEqual(view.recovery, { attempts: 4, limit: 4 });
  assert.deepEqual(view.evidence, [
    "event:7",
    "attempt-log-1",
    "event:11",
    "event:14",
  ]);
  const certain = runView(
    input({
      status: "running",
      observed: { attempt: 1, limit: 9 },
      effects: [effect({ status: "running", attempts: 7, limit: 8 })],
    }),
  );
  assert.deepEqual(certain.recovery, { attempts: 1, limit: 9 });
});
