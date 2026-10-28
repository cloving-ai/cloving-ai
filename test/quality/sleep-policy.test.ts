import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { proposedModulePolicy } from "../../quality/module-policy.ts";
import { checkReservedImports } from "../../quality/reserved-imports.ts";

await test("CLV-233 only the workflow sleep composition gains the SDK import allowance", () => {
  const policy = proposedModulePolicy(process.cwd());
  const helper = resolve("src/steps/sleep.ts");
  assert.equal(policy.roles[helper], "workflow");
  const target = resolve("node_modules/workflow/dist/index.d.ts");
  const edge = {
    from: helper,
    target,
    specifier: "workflow",
    kind: "value",
  } as const;
  assert.doesNotThrow(() => {
    checkReservedImports({ files: [helper], edges: [edge] }, policy);
  });
  const workflow = resolve("workflows/develop-ticket.ts");
  assert.throws(() => {
    checkReservedImports(
      { files: [workflow], edges: [{ ...edge, from: workflow }] },
      policy,
    );
  }, /reserved-import/);
});
