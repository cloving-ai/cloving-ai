import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { proposedModulePolicy } from "../../quality/module-policy.ts";
import { checkReservedImports } from "../../quality/reserved-imports.ts";

for (const name of ["api", "runtime"])
  await test(`CLV-219 workflows cannot import the SDK ${name} through the hook helper's allowance`, () => {
    const policy = proposedModulePolicy(process.cwd());
    const workflow = resolve("templates/develop/develop.ts");
    const target = resolve(`node_modules/workflow/dist/${name}.d.ts`);
    assert.throws(() => {
      checkReservedImports(
        {
          files: [workflow],
          edges: [
            {
              from: workflow,
              target,
              specifier: `workflow/${name}`,
              kind: "value",
            },
          ],
        },
        policy,
      );
    }, /reserved-import/);
  });
