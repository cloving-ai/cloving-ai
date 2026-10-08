import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { checkTests } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-10 matches executed test coverage through canonical paths", async () => {
  const source =
    'import { test } from "node:test"; import assert from "node:assert/strict"; await test("value", () => { assert.equal(1, 1); });';
  await withFiles({ "real.test.ts": source }, async (directory) => {
    const alias = join(directory, "alias.test.ts");
    await symlink(join(directory, "real.test.ts"), alias);
    assert.doesNotThrow(() => {
      checkTests(directory, [alias]);
    });
  });
});
