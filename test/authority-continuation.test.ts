import assert from "node:assert/strict";
import { test } from "node:test";
import { continuationStart } from "../src/authority/continuations.ts";
import { rebuildHistory } from "../src/authority/history.ts";
import { emptyAuthority } from "../src/authority/reducer.ts";
import {
  accepted,
  admission,
  applied,
  grant,
  letters,
  operationOf,
  rejection,
  report,
  request,
  started,
  type Fields,
} from "./effect-pure-fixture.ts";

function completed(round: number): readonly Fields[] {
  return [
    request(round),
    grant({ round, generation: 1 }),
    accepted(round),
    report(round, { result: letters(String(round)) }),
  ];
}

const failedMerge = [
  admission,
  started,
  ...completed(1),
  ...completed(2),
  request(3),
  grant({ round: 3, generation: 1 }),
  accepted(3),
  report(3, {
    outcome: "failed",
    result: undefined,
    reason: "git-call-failed",
  }),
  {
    kind: "fail-run",
    commandId: "c-fail",
    runId: "run-1",
    expectedRevision: 2,
  },
];

function continuation(reuseBefore: number, extra: Fields = {}): Fields {
  return {
    ...admission,
    commandId: "c-continue",
    runId: "run-2",
    continuedFrom: "run-1",
    reuseBefore,
    ...extra,
  };
}

const continuedStart = { ...started, commandId: "c-start-2", runId: "run-2" };

function continuedRequest(round: number): Fields {
  return {
    ...request(round),
    runId: "run-2",
    commandId: `c-continued-${String(round)}`,
    operationId: operationOf(round, "run-2"),
  };
}

function failedSequence(): number {
  const { state } = applied(failedMerge);
  const failed = state.effects.operations[operationOf(3)];
  assert.ok(failed);
  return failed.requestedSequence;
}

await test("CLV-307 a continuation gets the completed result of the old run again with existing", () => {
  const { state, last } = applied([
    ...failedMerge,
    continuation(failedSequence()),
    continuedStart,
    continuedRequest(1),
  ]);
  assert.deepEqual(last.disposition, {
    operationId: operationOf(1, "run-2"),
    disposition: "existing",
    reason: null,
  });
  const reused = state.effects.operations[operationOf(1, "run-2")];
  assert.equal(reused?.status, "completed");
  assert.equal(reused.result, letters("1"));
  assert.equal(reused.receipt, "receipt-1");
  assert.equal(reused.runId, "run-2");
  assert.equal(state.effects.budgets["run-2"]?.spent, 1);
  assert.deepEqual(last.intents, []);
});

await test("CLV-307 a continuation runs the failed effect and every effect at or after the start again", () => {
  const { state, last } = applied([
    ...failedMerge,
    continuation(failedSequence()),
    continuedStart,
    continuedRequest(3),
  ]);
  assert.equal(last.disposition?.disposition, "admitted");
  assert.equal(
    state.effects.operations[operationOf(3, "run-2")]?.status,
    "waiting",
  );
  const before =
    state.effects.operations[operationOf(2)]?.requestedSequence ?? 0;
  const restarted = applied([
    ...failedMerge,
    continuation(before),
    continuedStart,
    continuedRequest(2),
  ]);
  assert.equal(restarted.last.disposition?.disposition, "admitted");
});

await test("CLV-307 reused effects count against the effect limit of the continuation", () => {
  const { state } = applied([
    ...failedMerge,
    continuation(failedSequence(), { effectLimit: 1 }),
    continuedStart,
    continuedRequest(1),
  ]);
  const { last } = applied([continuedRequest(2)], state);
  assert.deepEqual(last.disposition, {
    operationId: operationOf(2, "run-2"),
    disposition: "refused",
    reason: "budget-exhausted",
  });
});

await test("CLV-307 the authority refuses a continuation of an unknown, active or cancelled run", () => {
  assert.equal(
    rejection(
      applied([admission]).state,
      continuation(1, { continuedFrom: "run-9" }),
    ),
    "unknown-continued-run",
  );
  assert.equal(
    rejection(applied([admission, started]).state, continuation(1)),
    "continued-run-active",
  );
  const cancelled = applied([
    admission,
    {
      kind: "cancel-run",
      commandId: "c-cancel",
      runId: "run-1",
      expectedRevision: 1,
    },
  ]).state;
  assert.equal(
    rejection(cancelled, continuation(1)),
    "continued-run-cancelled",
  );
  const failed = applied(failedMerge).state;
  assert.equal(
    rejection(failed, continuation(failed.sequence + 2)),
    "invalid-continuation-start",
  );
});

await test("CLV-307 a history rebuild reuses the same results as the live authority", () => {
  const steps = [
    ...failedMerge,
    continuation(failedSequence()),
    continuedStart,
    continuedRequest(1),
  ];
  const { state, last } = applied(steps);
  const history = rebuildHistory(events(steps));
  assert.deepEqual(history.state.effects.operations, state.effects.operations);
  assert.equal(
    history.evidence.at(-1)?.disposition,
    last.disposition?.disposition,
  );
});

function events(steps: readonly Fields[]): readonly unknown[] {
  const recorded: unknown[] = [];
  let state = emptyAuthority;
  for (const step of steps) {
    const next = applied([step], state);
    recorded.push(...next.last.events);
    state = next.state;
  }
  return recorded;
}

function stored(
  step: {
    readonly phase: string;
    readonly operation: string;
    readonly round: number;
  },
  record: { readonly status: string; readonly requestedSequence: number },
) {
  return {
    operationId: JSON.stringify([
      "cloving-operation",
      step.round,
      "run-1",
      step.phase,
      step.operation,
      null,
      null,
    ]),
    ...record,
  };
}

const mergeHistory = [
  stored(
    { phase: "pull-request", operation: "github-open-pr", round: 1 },
    { status: "completed", requestedSequence: 5 },
  ),
  stored(
    { phase: "merge", operation: "merge", round: 1 },
    { status: "failed", requestedSequence: 9 },
  ),
  stored(
    { phase: "pull-request", operation: "github-label", round: 1 },
    { status: "completed", requestedSequence: 12 },
  ),
];

await test("CLV-307 the continuation starts at the failed step, or at the first visit of a named step", () => {
  assert.deepEqual(continuationStart(mergeHistory, null), {
    kind: "start",
    reuseBefore: 9,
  });
  assert.deepEqual(
    continuationStart(mergeHistory, "pull-request/github-open-pr"),
    { kind: "start", reuseBefore: 5 },
  );
  assert.deepEqual(continuationStart(mergeHistory, "merge/merge/1"), {
    kind: "start",
    reuseBefore: 9,
  });
  assert.deepEqual(continuationStart(mergeHistory, "merge/merge/2"), {
    kind: "refused",
    reason: "unknown-continuation-step",
  });
  assert.deepEqual(continuationStart(mergeHistory, "merge"), {
    kind: "refused",
    reason: "invalid-continuation-step",
  });
  const blocked = mergeHistory.map((operation) => ({
    ...operation,
    status: "completed",
  }));
  assert.deepEqual(continuationStart(blocked, null), {
    kind: "refused",
    reason: "continuation-step-required",
  });
});
