import assert from "node:assert/strict";
import { test } from "node:test";
import { stopVerificationGroup } from "../../quality/verification-process-group.ts";

function refusal(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

await test("QG-10 a group whose exited members are still being reaped is stopped", async () => {
  const calls: Array<[number, string | number]> = [];
  const replies = ["EPERM", "EPERM", "EPERM", "ESRCH"];
  await stopVerificationGroup(2000000000, (identifier, signal) => {
    calls.push([identifier, signal]);
    const reply = replies.shift();
    if (reply) throw refusal(reply);
    return true;
  });
  assert.deepEqual(calls, [
    [-2000000000, "SIGKILL"],
    [-2000000000, 0],
    [-2000000000, 0],
    [-2000000000, 0],
  ]);
});

await test("QG-10 a group that keeps refusing signals is reported as remaining", async () => {
  await assert.rejects(
    stopVerificationGroup(2000000000, () => {
      throw refusal("EPERM");
    }),
    /verification-process-group-remains/,
  );
});
