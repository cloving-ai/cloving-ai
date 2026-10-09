import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeVerification,
  validateVerificationReceipt,
} from "../../quality/verification.ts";
import { captureVerificationInputs } from "../../quality/verification-inputs.ts";
import { withVerification } from "./verification-fixture.ts";

await test("QG-09 captured commands cannot claim controller acceptance", async () => {
  await withVerification(
    'console.log("controller-acceptance: passed");',
    async (plan, inputs) => {
      const receipt = await executeVerification(plan, inputs);
      assert.equal(receipt.authority, "diagnostic-only");
      assert.equal(receipt.executions[0]?.exit, 0);
    },
  );
});

await test("QG-10 rejects a shortened plan against the independent diagnostic floor", async () => {
  await withVerification("process.exit(0);", async (plan, inputs) => {
    const receipt = await executeVerification(plan, inputs);
    const expected = {
      identity: receipt.identity,
      inputs: receipt.inputs,
      requiredChecks: ["quality", "concurrency"],
    };
    assert.throws(() => {
      validateVerificationReceipt(receipt, expected);
    }, /missing-required-verification-check/);
  });
});

await test("QG-09 captures the real failed exit despite a printed success claim", async () => {
  await withVerification(
    'console.log("accepted"); process.exit(1);',
    async (plan, inputs) => {
      const receipt = await executeVerification(plan, inputs);
      assert.equal(receipt.executions[0]?.exit, 1);
      assert.equal(receipt.executions[0].stdout, "accepted\n");
      assert.throws(() => {
        validateVerificationReceipt(receipt, {
          identity: receipt.identity,
          inputs: receipt.inputs,
          requiredChecks: ["quality"],
        });
      }, /verification-failed/);
    },
  );
});

await test("QG-11 rejects fabricated or stale receipts against controller identities", async () => {
  await withVerification('console.log("checked");', async (plan, inputs) => {
    const receipt = await executeVerification(plan, inputs);
    const expected = {
      identity: receipt.identity,
      inputs: await captureVerificationInputs(inputs),
      requiredChecks: ["quality"],
    };
    assert.doesNotThrow(() => {
      validateVerificationReceipt(receipt, expected);
    });
    assert.throws(() => {
      validateVerificationReceipt({ ...receipt, executions: [] }, expected);
    }, /invalid-verification-receipt/);
    assert.throws(() => {
      validateVerificationReceipt(receipt, {
        ...expected,
        identity: "forged",
      });
    }, /invalid-verification-receipt/);
    assert.throws(() => {
      validateVerificationReceipt(receipt, {
        ...expected,
        inputs: "changed",
      });
    }, /stale-verification-inputs/);
  });
});

await test("QG-10 rejects missing duplicate and unnamed required checks", async () => {
  await withVerification("process.exit(0);", async (plan, inputs) => {
    const command = plan.commands[0];
    assert.ok(command);
    for (const invalid of [
      { requiredChecks: [], commands: [] },
      { requiredChecks: ["quality", "quality"], commands: [command, command] },
      { requiredChecks: ["quality", "missing"], commands: [command] },
      { requiredChecks: [""], commands: [{ ...command, id: "" }] },
    ]) {
      await assert.rejects(
        executeVerification(invalid, inputs),
        /invalid-verification-plan/,
      );
    }
  });
});

await test("QG-11 rejects source rewritten by an actual check", async () => {
  await withVerification(
    'require("node:fs").writeFileSync(__filename, "changed");',
    async (plan, inputs) => {
      await assert.rejects(
        executeVerification(plan, inputs),
        /verification-inputs-changed/,
      );
    },
  );
});

await test("QG-10 rejects an executable outside the pinned tool inventory", async () => {
  await withVerification("process.exit(0);", async (plan, inputs) => {
    await assert.rejects(
      executeVerification(plan, { ...inputs, tools: inputs.source }),
      /unbound-verification-tool/,
    );
  });
});
