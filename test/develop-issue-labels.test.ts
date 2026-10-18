import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProtectedResult } from "../src/step-bridge.ts";
import { field, ran, request } from "./develop-workflow-fixture.ts";
import {
  completed,
  cycleId,
  first,
  input,
  merged,
  payloadOf,
  prepared,
  pull,
  review,
  steps,
  turned,
} from "./develop-issue-fixture.ts";

function scenario(labels: readonly ProtectedResult[]): {
  readonly input: typeof input;
  readonly effects: Readonly<Record<string, readonly ProtectedResult[]>>;
} {
  return {
    input,
    effects: {
      "github prepare": [prepared],
      "github label": labels,
      "claude run-turn": [turned],
      "github open-pr": [pull(first)],
      "github wait-review": [review(first, 5)],
      "github merge": [merged],
      "github close-issue": [completed({})],
    },
  };
}

await test("CLV-069 failed label steps are requested without changing the merged outcome", async () => {
  const failures = (
    [
      "failed",
      "stopped",
      "blocked",
      "cancelled",
      "refused",
      "unavailable",
    ] as const
  ).map((kind): ProtectedResult => ({
    kind,
    operationId: "label-operation",
    reason: "label-not-available",
  }));
  const lines = await ran(
    failures.map((failure) => scenario([failure, failure])),
  );
  for (const line of lines) {
    assert.deepEqual(field(line, "outcome"), {
      kind: "handoff_requested",
      cycleId,
      promotionId: "pull-request-7",
      ticketStatus: "complete",
    });
    assert.deepEqual(
      steps(line).map((step) => field(step, 1)),
      [
        "prepare",
        "label",
        "run-turn",
        "open-pr",
        "wait-review",
        "merge",
        "close-issue",
      ],
    );
    assert.deepEqual(field(field(request(line, 1), "scope"), "key"), "start");
  }
});

await test("CLV-069 every blocked step after preparation attempts the blocked label and preserves its outcome", async () => {
  const failure: ProtectedResult = {
    kind: "failed",
    operationId: "operation",
    reason: "test-failure",
  };
  const cases = [
    "claude run-turn",
    "github open-pr",
    "github wait-review",
    "github merge",
  ];
  for (const step of cases) {
    const given = scenario([completed({}), failure]);
    const [line] = await ran([
      {
        ...given,
        effects: { ...given.effects, [step]: [failure] },
      },
    ]);
    const operation =
      step === "claude run-turn" ? "claude-turn" : step.replace(" ", "-");
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      cycleId,
      evidenceId: operation,
      reason: `The step ${operation} has the result failed (test-failure).`,
    });
    const index = steps(line).length - 1;
    assert.equal(field(steps(line).at(-1), 1), "label");
    assert.deepEqual(JSON.parse(payloadOf(line, index)), {
      owner: "cloving-ai",
      repository: "cloving-ai",
      number: 63,
      add: ["cloving: blocked"],
      remove: ["cloving: in progress"],
    });
    assert.equal(field(field(request(line, index), "scope"), "key"), "blocked");
  }
});

await test("CLV-069 preparation failure and tickets without an issue make no label requests", async () => {
  const given = scenario([]);
  const lines = await ran([
    {
      ...given,
      effects: {
        "github prepare": [
          { kind: "failed", operationId: "prepare", reason: "no-tree" },
        ],
      },
    },
    { ...given, input: { ...input, ticket: "A task without an issue." } },
  ]);
  assert.equal(steps(lines[0]).length, 1);
  assert.equal(steps(lines[1]).length, 5);
  assert.ok(
    lines.every((line) =>
      steps(line).every((step) => field(step, 1) !== "label"),
    ),
  );
  assert.equal(field(field(lines[1], "outcome"), "kind"), "handoff_requested");
});

await test("CLV-069 start label and completion payloads name the ticket issue", async () => {
  const [line] = await ran([scenario([completed({}), completed({})])]);
  assert.deepEqual(JSON.parse(payloadOf(line, 1)), {
    owner: "cloving-ai",
    repository: "cloving-ai",
    number: 63,
    add: ["cloving: in progress"],
    remove: ["cloving: ready", "cloving: blocked"],
  });
  assert.deepEqual(JSON.parse(payloadOf(line, 6)), {
    owner: "cloving-ai",
    repository: "cloving-ai",
    number: 63,
    pullRequest: 7,
  });
});
