import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessStartRequest } from "../src/harness-start.ts";

await test("CLV-209 a shell start without SHELL cannot execute the entry directly", () => {
  const request = harnessStartRequest(
    { name: "custom", kind: "shell", path: "custom" },
    {
      environment: {},
      repository: "/repository",
      message: "setup",
    },
  );
  assert.equal(request.executable, "");
  assert.deepEqual(request.arguments.slice(-2), ["custom", "setup"]);
  assert.deepEqual(request.arguments.slice(0, 4), ["-l", "-i", "+m", "-c"]);
});
