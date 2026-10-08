import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { inspectClones } from "../../quality/clones.ts";
import { withFiles } from "./files-fixture.ts";

for (const extension of ["jsx", "tsx", "js", "mjs", "cjs"]) {
  await test(`QG-10 rejects unqualified JSX syntax in ${extension}`, async () => {
    await withFiles(
      {
        [`view.${extension}`]:
          "export const view = <div>{/* different */}text</div>;",
      },
      async (directory) => {
        await assert.rejects(
          inspectClones([join(directory, `view.${extension}`)]),
          /JSX clone analysis is unqualified/,
        );
      },
    );
  });
}

await test("QG-14 permits JSX-like text inside a JavaScript string", async () => {
  await withFiles(
    { "text.js": 'export const text = "<div>text</div>";' },
    async (directory) => {
      assert.deepEqual(await inspectClones([join(directory, "text.js")]), []);
    },
  );
});
