import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runClosure,
  stopAttempts,
  stopClasses,
  stopCount,
  type AttemptSummary,
  type StopSubject,
} from "../src/authority/stop-sequence.ts";

function attempt(purpose: string, outcome: string | null): AttemptSummary {
  return { effectId: "effect-1", purpose, outcome, stagedSequence: 5 };
}

function staged(sequence: number, summary: AttemptSummary): AttemptSummary {
  return { ...summary, stagedSequence: sequence };
}

function start(attempts: readonly AttemptSummary[]): StopSubject {
  return {
    operationId: "start-1",
    kind: "start-run",
    attempts,
    status: null,
    receipt: null,
    stopped: false,
  };
}

function effect(
  parts: Pick<StopSubject, "status" | "receipt">,
  attempts: readonly AttemptSummary[],
): StopSubject {
  return {
    operationId: "effect-1",
    kind: "protected-effect",
    attempts,
    stopped: false,
    ...parts,
  };
}

function classOf(subject: StopSubject): string | undefined {
  return stopClasses([subject]).get(subject.operationId);
}

const rule = {
  cancelledSequence: 5,
  stopLimit: 3,
  stopSupported: true,
  opening: false,
  rejected: new Set<string>(),
};

const sent = attempt("dispatch", "sent");
const failed = attempt("dispatch", "failed");
const accepted = attempt("dispatch", "accepted");

await test("CLV-049 the stop class of a start or a continuation of a dropped run is open, resolved, unknown or alive", () => {
  for (const [subject, expected] of [
    [start([attempt("dispatch", null)]), "open"],
    [start([attempt("dispatch", "withheld")]), "resolved"],
    [start([attempt("dispatch", "blocked")]), "resolved"],
    [start([failed, attempt("reconcile", "absent")]), "resolved"],
    [start([failed]), "unknown"],
    [start([attempt("dispatch", "stale-epoch")]), "unknown"],
    [start([failed, attempt("reconcile", "unknown")]), "unknown"],
    [start([sent]), "alive"],
    [start([sent, attempt("stop", "unknown")]), "alive"],
    [{ ...start([sent]), stopped: true }, "resolved"],
  ] as const)
    assert.equal(classOf(subject), expected, JSON.stringify(subject));
});

await test("CLV-049 each dispatched start or continuation of a dropped run is alive until its stop is confirmed, and each one gets a stop request", () => {
  const first = start([sent]);
  const later = {
    ...start([sent]),
    operationId: "continue-1",
    kind: "continue-run",
  };
  assert.deepEqual(
    [...stopClasses([first, later])],
    [
      ["start-1", "alive"],
      ["continue-1", "alive"],
    ],
  );
  assert.deepEqual(
    [...stopClasses([{ ...first, stopped: true }, later])],
    [
      ["start-1", "resolved"],
      ["continue-1", "alive"],
    ],
  );
  assert.deepEqual(
    stopAttempts([first, later], rule).map((attempt) => [
      attempt.operationId,
      attempt.purpose,
    ]),
    [
      ["start-1", "stop"],
      ["continue-1", "stop"],
    ],
  );
});

await test("CLV-049 the stop class of a protected operation of a dropped run is resolved when it is final, alive with a stored receipt and unknown with none", () => {
  const unknown = attempt("dispatch", "unknown");
  for (const [subject, expected] of [
    [effect({ status: "completed", receipt: "r-1" }, [accepted]), "resolved"],
    [effect({ status: "cancelled", receipt: null }, [failed]), "resolved"],
    [effect({ status: "running", receipt: "r-1" }, [accepted]), "alive"],
    [effect({ status: "recovering", receipt: "r-1" }, [accepted]), "alive"],
    [effect({ status: "recovering", receipt: null }, [unknown]), "unknown"],
    [effect({ status: "blocked", receipt: null }, [unknown]), "unknown"],
    [
      effect({ status: "running", receipt: "r-1" }, [attempt("stop", null)]),
      "open",
    ],
  ] as const)
    assert.equal(classOf(subject), expected, JSON.stringify(subject));
});

await test("CLV-049 the next attempt of the stop sequence is a reconciliation for the class unknown and a stop request for the class alive with a stop function, below the stop limit", () => {
  const unknown = start([failed]);
  const alive = effect({ status: "running", receipt: "r-1" }, [accepted]);
  const resolved = { ...start([attempt("dispatch", "withheld")]) };
  assert.deepEqual(
    stopAttempts(
      [unknown, alive, { ...resolved, operationId: "start-2" }],
      rule,
    ),
    [
      { operationId: "start-1", kind: "start-run", purpose: "reconcile" },
      { operationId: "effect-1", kind: "protected-effect", purpose: "stop" },
    ],
  );
  assert.deepEqual(
    stopAttempts([unknown, alive], { ...rule, stopSupported: false }),
    [{ operationId: "start-1", kind: "start-run", purpose: "reconcile" }],
  );
});

const bounded = effect({ status: "running", receipt: "r-1" }, [
  staged(3, accepted),
  staged(4, attempt("reconcile", "accepted")),
  staged(5, attempt("stop", "unknown")),
  staged(6, attempt("reconcile", "accepted")),
  staged(7, attempt("stop", "unknown")),
]);

const stopRequest = {
  operationId: "effect-1",
  kind: "protected-effect",
  purpose: "stop",
};

await test("CLV-049 the stop sequence counts the closed stop and reconciliation attempts after the cancellation, stops at the limit, and an opening gives one more attempt", () => {
  assert.equal(stopCount(bounded, 5), 3);
  assert.equal(stopCount(bounded, 6), 2);
  assert.equal(stopCount(bounded, 3), 4);
  const open = {
    ...bounded,
    attempts: [...bounded.attempts, staged(8, attempt("stop", null))],
  };
  assert.equal(stopCount(open, 5), 3);
  assert.deepEqual(stopAttempts([bounded], rule), []);
  assert.deepEqual(stopAttempts([bounded], { ...rule, stopLimit: 4 }), [
    stopRequest,
  ]);
  assert.deepEqual(stopAttempts([bounded], { ...rule, opening: true }), [
    stopRequest,
  ]);
  assert.deepEqual(stopAttempts([open], { ...rule, opening: true }), []);
  const reported = { ...rule, rejected: new Set(["effect-1"]) };
  assert.deepEqual(stopAttempts([bounded], reported), [stopRequest]);
  assert.deepEqual(stopAttempts([open], reported), []);
  assert.deepEqual(
    stopAttempts([bounded], { ...rule, rejected: new Set(["effect-2"]) }),
    [],
  );
});

await test("CLV-049 with no stop function, an accepted protected operation whose lease time ended gets a reconciliation by the count rule of the stop sequence, and a running one and a sent start get no attempt", () => {
  const withoutStop = { ...rule, stopSupported: false };
  const reconciliation = { ...stopRequest, purpose: "reconcile" };
  for (const status of ["recovering", "blocked"])
    assert.deepEqual(
      stopAttempts([effect({ status, receipt: "r-1" }, [accepted])], {
        ...rule,
        stopSupported: false,
      }),
      [reconciliation],
      status,
    );
  assert.deepEqual(
    stopAttempts(
      [
        effect({ status: "running", receipt: "r-1" }, [accepted]),
        start([sent]),
      ],
      withoutStop,
    ),
    [],
  );
  const expired = { ...bounded, status: "recovering" };
  assert.deepEqual(stopAttempts([expired], withoutStop), []);
  assert.deepEqual(stopAttempts([expired], { ...withoutStop, opening: true }), [
    reconciliation,
  ]);
  assert.deepEqual(
    stopAttempts([expired], {
      ...withoutStop,
      rejected: new Set(["effect-1"]),
    }),
    [reconciliation],
  );
  assert.deepEqual(stopAttempts([{ ...expired, attempts: [accepted] }], rule), [
    stopRequest,
  ]);
  assert.equal(runClosure([expired], withoutStop).closure, "stop-unconfirmed");
});

await test("CLV-049 the closure of a dropped run is cancelled only when each operation is resolved, it is stop-unconfirmed at the stop limit, and it names each operation with no known result", () => {
  const resolved = { ...start([attempt("dispatch", "withheld")]) };
  const alive = effect({ status: "running", receipt: "r-1" }, [accepted]);
  const stopping = { ...alive, attempts: [accepted, attempt("stop", null)] };
  const starting = start([attempt("dispatch", null)]);
  const unknown = { ...start([failed]), operationId: "start-2" };
  const cancelled = { closure: "cancelled", unresolved: [], open: false };
  assert.deepEqual(runClosure([], rule), cancelled);
  assert.deepEqual(runClosure([resolved], rule), cancelled);
  assert.deepEqual(runClosure([resolved, alive], rule), {
    closure: "stop-not-observed",
    unresolved: [],
    open: false,
  });
  assert.deepEqual(runClosure([stopping], rule), {
    closure: "stop-not-observed",
    unresolved: [],
    open: true,
  });
  assert.deepEqual(runClosure([starting, unknown], rule), {
    closure: "stop-not-observed",
    unresolved: ["start-1", "start-2"],
    open: true,
  });
  assert.deepEqual(runClosure([resolved, bounded], rule), {
    closure: "stop-unconfirmed",
    unresolved: [],
    open: false,
  });
  assert.deepEqual(
    runClosure([{ ...bounded, status: "stopped" }], rule),
    cancelled,
  );
});
