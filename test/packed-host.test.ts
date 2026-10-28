import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedExit } from "./packed-host-fixture.ts";

await test("CLV-233 packed host exit preserves an Error rejection as its cause", async () => {
  const cause = new Error("host failed");
  await assert.rejects(boundedExit(Promise.reject(cause)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Installed startup failed");
    assert.equal(error.cause, cause);
    return true;
  });
});

await test("CLV-233 packed host exit omits non-Error rejection causes", async () => {
  for (const cause of [
    "host failed",
    { message: "host failed" },
    null,
    undefined,
    7,
  ]) {
    const closed = Promise.withResolvers<number | null>();
    const result = boundedExit(closed.promise);
    closed.reject(cause);
    await assert.rejects(result, {
      message: "Installed startup failed",
      cause: undefined,
    });
  }
});
