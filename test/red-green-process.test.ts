import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { redGreenProcess } from "../tools/red-green-process.ts";

await test("CLV-248 an empty executable array cannot start a test process", async () => {
  await assert.rejects(
    redGreenProcess([], {
      directory: tmpdir(),
      signal: new AbortController().signal,
      milliseconds: 1000,
    }),
    { code: "ERR_INVALID_ARG_VALUE" },
  );
});

await test("CLV-248 denied group termination falls back to the direct child", async () => {
  const original = process.kill.bind(process);
  let groupAttempts = 0;
  process.kill = (identifier, signal) => {
    if (identifier < 0) {
      groupAttempts++;
      throw Object.assign(new Error("Group termination denied"), {
        code: "EPERM",
      });
    }
    return original(identifier, signal);
  };
  try {
    const result = await redGreenProcess(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      {
        directory: tmpdir(),
        signal: new AbortController().signal,
        milliseconds: 10,
      },
    );
    assert.equal(result.status, null);
    assert.match(result.output, /timed out/);
    assert.ok(groupAttempts > 0);
  } finally {
    process.kill = original;
  }
});
