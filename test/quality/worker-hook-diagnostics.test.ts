import assert from "node:assert/strict";
import { test } from "node:test";
import { runHook, withHook } from "./worker-hook-fixture.ts";

await test("CLV-104 unexpected hook exits and signals retain failure details", () => {
  for (const scenario of [
    { command: "process.exit(0)", signal: "none", exit: "0" },
    {
      command: "process.kill(process.pid, 'SIGTERM')",
      signal: "SIGTERM",
      exit: "null",
    },
  ]) {
    assert.throws(
      () =>
        runHook({
          arguments: [
            "-e",
            `require('node:fs').writeSync(2, 'last-hook-phase'); ${scenario.command}`,
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /elapsed=\d+ms/);
        assert.ok(error.message.includes(`signal=${scenario.signal}`));
        assert.ok(error.message.includes(`exit=${scenario.exit}`));
        assert.match(error.message, /error=none/);
        assert.ok(error.message.endsWith("stderr tail:\nlast-hook-phase"));
        return true;
      },
    );
  }
});

await test("CLV-104 timed out hook failure retains timing, termination and the bounded stderr tail", () => {
  assert.throws(
    () =>
      runHook({
        arguments: [
          "-e",
          "require('node:fs').writeSync(2, 'discard-me' + 'x'.repeat(5000) + 'last-hook-phase'); setInterval(() => {}, 1000)",
        ],
        timeout: 250,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /elapsed=\d+ms/);
      assert.match(error.message, /signal=SIGTERM/);
      assert.match(error.message, /exit=null/);
      assert.match(error.message, /error=ETIMEDOUT/);
      const tail = error.message.split("stderr tail:\n")[1];
      assert.ok(tail);
      assert.equal(tail.length, 4000);
      assert.ok(tail.endsWith("last-hook-phase"));
      assert.doesNotMatch(error.message, /discard-me/);
      return true;
    },
  );
});

await test("CLV-104 expected hook exit retains raw context when its diagnostic assertion fails", async () => {
  await assert.rejects(
    withHook("export const value = 1;\n", (dispatch) => {
      const result = dispatch(
        {},
        {
          arguments: [
            "-e",
            "require('node:fs').writeSync(2, 'discard-me' + 'x'.repeat(5000) + '\\n[cloving-worker-hook] 5ms lint:start\\n$&\\nspawnSync node ETIMEDOUT'); process.exit(2)",
          ],
        },
      );
      assert.match(result.diagnostic, /max-lines-per-function/);
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /elapsed=\d+ms signal=none exit=2 error=none/,
      );
      const tail = error.message.split("stderr tail:\n")[1];
      assert.ok(tail);
      assert.equal(tail.length, 4000);
      assert.match(tail, /\[cloving-worker-hook\] 5ms lint:start/);
      assert.ok(tail.endsWith("spawnSync node ETIMEDOUT"));
      assert.doesNotMatch(tail, /discard-me/);
      assert.doesNotMatch(error.stack ?? "", /discard-me/);
      return true;
    },
  );
});
