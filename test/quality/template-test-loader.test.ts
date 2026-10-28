import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withFiles } from "./files-fixture.ts";
import { testCommand } from "../../quality/test-execution.ts";

await test("CLV-221 the repository test command loads public template imports without an installed package", () =>
  withFiles(
    {
      "template.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
await test("public template bridge", async () => {
  using bridge = fakeStepBridge({ effectLimit: 0 });
  const result = await protectedEffect({
    scope: { phase: "implement", operation: "claude-turn", round: 1 },
    capability: "claude", method: "run-turn", target: "task", payload: "task", units: 1,
  });
  assert.deepEqual(result, { kind: "refused", reason: "budget-exhausted" });
  assert.equal(bridge.requests.length, 1);
});`,
    },
    (directory) => {
      const command = testCommand(resolve("."), {
        tests: [join(directory, "template.test.ts")],
      });
      const output = execFileSync(command.executable, command.arguments, {
        cwd: directory,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        encoding: "utf8",
        timeout: 15000,
      });
      const report: unknown = JSON.parse(output);
      assert.ok(report !== null && typeof report === "object");
      assert.equal(Reflect.get(report, "completed"), 1);
      assert.deepEqual(Reflect.get(report, "failures"), []);
      assert.deepEqual(Reflect.get(report, "skipped"), []);
    },
  ));
