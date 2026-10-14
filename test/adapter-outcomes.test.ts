import assert from "node:assert/strict";
import { test } from "node:test";
import { settlement } from "../src/broker/actor/adapter-outcomes.ts";

function replied(reply: unknown): ReturnType<typeof settlement> {
  return settlement({ kind: "replied", reply }, 8);
}

const malformed = { kind: "unknown", reason: "invalid-adapter-reply" };
const identified = { receipt: "r-1", worker: null };

await test("CLV-049 an adapter reply of each known kind gives its settlement", () => {
  assert.deepEqual(
    [
      replied({ kind: "absent" }),
      replied({ kind: "accepted", receipt: "r-1", worker: "w-1" }),
      replied({ receipt: "r-1", worker: "w-1" }),
      replied({ kind: "completed", receipt: "r-1", result: "12345678" }),
      replied({ kind: "completed", receipt: "r-1", result: "123456789" }),
      replied({ kind: "failed", reason: "tool-exit" }),
      replied({ kind: "stopped" }),
      replied({ kind: "unknown", evidence: "no trace" }),
    ],
    [
      { kind: "absent" },
      { kind: "accepted", receipt: "r-1", worker: "w-1" },
      { kind: "accepted", receipt: "r-1", worker: "w-1" },
      { ...identified, kind: "completed", result: "12345678", reason: null },
      {
        ...identified,
        kind: "completed",
        result: null,
        reason: "result-too-large",
      },
      { kind: "failed", receipt: null, worker: null, reason: "tool-exit" },
      { kind: "stopped", receipt: null, worker: null },
      { kind: "unknown", reason: "adapter-unknown" },
    ],
  );
});

await test("CLV-049 a completed, failed or stopped reply keeps the receipt and the worker identity that it gives", () => {
  const given = { receipt: "r-1", worker: "w-1" };
  assert.deepEqual(
    [
      replied({ ...given, kind: "completed", result: "done" }),
      replied({ ...given, kind: "failed", reason: "tool-exit" }),
      replied({ ...given, kind: "stopped" }),
    ],
    [
      { ...given, kind: "completed", result: "done", reason: null },
      { ...given, kind: "failed", reason: "tool-exit" },
      { ...given, kind: "stopped" },
    ],
  );
});

await test("CLV-066 a failed reply keeps a result that is in the size limit, and drops a result that is too large", () => {
  const failure = { kind: "failed", reason: "tool-exit" };
  assert.deepEqual(
    [
      replied({ ...failure, result: "12345678" }),
      replied({ ...failure, result: "123456789" }),
    ],
    [
      { ...failure, receipt: null, worker: null, result: "12345678" },
      { ...failure, receipt: null, worker: null },
    ],
  );
});

await test("CLV-049 an adapter reply whose kind is the name of an inherited object property is an unknown outcome", () => {
  for (const kind of [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])
    assert.deepEqual(
      replied(
        Object.fromEntries([
          ["kind", kind],
          ["receipt", "r-1"],
          ["worker", "w-1"],
        ]),
      ),
      malformed,
      kind,
    );
});

await test("CLV-049 an adapter reply of a wrong form is an unknown outcome", () => {
  for (const reply of [
    null,
    "accepted",
    {},
    { kind: "pending" },
    { kind: "pending", receipt: "r-1", worker: "w-1" },
    { kind: 7 },
    { kind: "accepted", receipt: "r-1" },
    { kind: "accepted", receipt: "two words", worker: "w-1" },
    { receipt: "r-1", worker: "two words" },
    { kind: "completed", receipt: "r-1" },
    { kind: "completed", receipt: "r-1", result: 7 },
    { kind: "completed", result: "done" },
    { kind: "completed", receipt: "two words", result: "done" },
    { kind: "completed", receipt: "r-1", worker: "two words", result: "done" },
    { kind: "failed" },
    { kind: "failed", reason: "two words" },
    { kind: "failed", receipt: 7, reason: "tool-exit" },
    { kind: "stopped", receipt: "two words" },
    { kind: "stopped", worker: 7 },
  ])
    assert.deepEqual(replied(reply), malformed, JSON.stringify(reply));
});

await test("CLV-049 a thrown adapter call and a call above its time limit are unknown outcomes with their reasons", () => {
  assert.deepEqual(
    [
      settlement({ kind: "thrown", message: "the reply is lost" }, 8),
      settlement({ kind: "overdue" }, 8),
    ],
    [
      { kind: "unknown", reason: "adapter-failure" },
      { kind: "unknown", reason: "time-limit" },
    ],
  );
});
