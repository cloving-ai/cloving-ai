import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { boundedExit, stopPackedHost } from "./packed-host-fixture.ts";
import { signalGroup, stopChildGroup } from "./stop-child.ts";

await test("CLV-366 packed host shutdown cleans up its process group after the exit timeout", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => process.exit(0));
spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); console.log("ready");'], { stdio: ["ignore", "inherit", "inherit"] });
`,
    ],
    {
      detached: true,
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const closed = new Promise<number | null>((settle) =>
    child.once("close", settle),
  );
  try {
    await once(child.stdout, "data");
    await assert.rejects(stopPackedHost({ child, closed }), {
      message: "Installed startup did not stop",
    });
    assert.equal(signalGroup(Number(child.pid), 0), false);
  } finally {
    await stopChildGroup(child, { graceMilliseconds: 50 });
    await closed;
  }
});

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
