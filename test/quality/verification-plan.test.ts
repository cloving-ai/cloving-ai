import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  executeVerification,
  validateVerificationReceipt,
} from "../../quality/verification.ts";
import { withVerification } from "./verification-fixture.ts";

await test("QG-09 snapshots mutable command arguments before asynchronous execution", async () => {
  await withVerification("process.exit(0);", async (plan, inputs) => {
    const command = plan.commands[0];
    assert.ok(command);
    const argumentsList = ["-e", "process.exit(0);"];
    const execution = executeVerification(
      { ...plan, commands: [{ ...command, arguments: argumentsList }] },
      inputs,
    );
    argumentsList[1] = "process.exit(19);";
    const receipt = await execution;
    assert.equal(receipt.executions[0]?.exit, 0);
    assert.deepEqual(receipt.plan.commands[0]?.arguments, [
      "-e",
      "process.exit(0);",
    ]);
  });
});

await test("QG-09 executes the canonical pinned tool after its alias is retargeted", async () => {
  await withVerification(
    'const fs = require("node:fs"); fs.unlinkSync(process.argv[2]); fs.symlinkSync("/usr/bin/true", process.argv[2]);',
    async (plan, inputs) => {
      const command = plan.commands[0];
      assert.ok(command);
      const alias = join(command.directory, "selected-tool");
      await symlink("/usr/bin/false", alias);
      const receipt = await executeVerification(
        {
          requiredChecks: ["prepare", "quality"],
          commands: [
            {
              ...command,
              id: "prepare",
              arguments: [...command.arguments, alias],
            },
            { ...command, executable: alias, arguments: [] },
          ],
        },
        { ...inputs, tools: [...inputs.tools, "/usr/bin/false"] },
      );
      assert.equal(receipt.executions[1]?.exit, 1);
      assert.equal(receipt.plan.commands[1]?.executable, "/usr/bin/false");
      assert.throws(() => {
        validateVerificationReceipt(receipt, {
          identity: receipt.identity,
          inputs: receipt.inputs,
          requiredChecks: ["prepare", "quality"],
        });
      }, /verification-failed/);
    },
  );
});
