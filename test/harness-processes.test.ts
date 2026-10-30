import assert from "node:assert/strict";
import { test } from "node:test";
import { terminateHarness } from "../src/cli/harness-processes.ts";

await test("CLV-209 termination reaches descendants before their parents without signaling unrelated processes", () => {
  const signaled: number[] = [];
  terminateHarness(10, {
    snapshot: () => "40 30\n99 1\n30 20\n20 10\n10 1\n",
    kill: (identifier, signal) => {
      assert.equal(signal, "SIGTERM");
      signaled.push(identifier);
      return true;
    },
  });
  assert.deepEqual(signaled, [40, 30, 20, 10]);
});

await test("CLV-209 termination falls back to the direct harness when the process snapshot is unavailable", () => {
  const signaled: number[] = [];
  terminateHarness(10, {
    snapshot: () => {
      throw new Error("snapshot unavailable");
    },
    kill: (identifier) => {
      signaled.push(identifier);
      return true;
    },
  });
  assert.deepEqual(signaled, [10]);
});

await test("CLV-209 termination ignores a vanished descendant and still reaches its parents", () => {
  const signaled: number[] = [];
  terminateHarness(10, {
    snapshot: () => "30 20\n20 10\n10 1\n",
    kill: (identifier) => {
      signaled.push(identifier);
      if (identifier === 30)
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    },
  });
  assert.deepEqual(signaled, [30, 20, 10]);
});

await test("CLV-209 termination surfaces signal failures other than a vanished process", () => {
  const failures: readonly (Error | string)[] = [
    Object.assign(new Error("denied"), { code: "EPERM" }),
    new Error("unknown"),
    "unknown",
  ];
  for (const failure of failures) {
    assert.throws(
      () => {
        terminateHarness(10, {
          snapshot: () => "10 1\n",
          kill: () => {
            AbortSignal.abort(failure).throwIfAborted();
            return true;
          },
        });
      },
      (error) => error === failure,
    );
  }
});

await test("CLV-209 a harness that did not spawn has no processes to stop", () => {
  terminateHarness(undefined, {
    snapshot: () => {
      assert.fail("No snapshot for an absent harness");
    },
    kill: () => {
      assert.fail("No signal for an absent harness");
    },
  });
});
