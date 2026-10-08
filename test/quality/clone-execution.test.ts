import assert from "node:assert/strict";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { test } from "node:test";
import { inspectClones } from "../../quality/clones.ts";
import { withFiles } from "./files-fixture.ts";

const expression = Array.from(
  { length: 75 },
  (_, index) => `value${String(index)}`,
).join(" + ");

for (const extension of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
  await test(`QG-14 actual clone scan covers ${extension} at 149/150 tokens`, async () => {
    for (const count of [149, 150]) {
      const source = expression + (count === 150 ? ";" : "");
      await withFiles(
        { [`first.${extension}`]: source, [`second.${extension}`]: source },
        async (directory) => {
          const findings = await inspectClones([
            join(directory, `first.${extension}`),
            join(directory, `second.${extension}`),
          ]);
          assert.equal(findings.length, count === 150 ? 1 : 0);
          assert.equal(findings[0]?.tokens, count === 150 ? 150 : undefined);
        },
      );
    }
  });
}

await test("QG-14 ignores comments and whitespace without losing cross-extension duplicates", async () => {
  const decorated = expression.replaceAll(" + ", " + /* harmless */\n ") + ";";
  await withFiles(
    { "first.ts": expression + ";", "second.js": decorated },
    async (directory) => {
      const findings = await inspectClones([
        join(directory, "first.ts"),
        join(directory, "second.js"),
      ]);
      assert.equal(findings[0]?.tokens, 150);
    },
  );
});

await test("QG-10 rejects missing and empty clone targets", async () => {
  await assert.rejects(inspectClones([]), /empty clone/i);
  await assert.rejects(inspectClones(["/not-a-cloving-source.ts"]), /ENOENT/);
});

await test("QG-14 canonicalizes clone target paths before checking report coverage", async () => {
  const source = expression + ";";
  await withFiles(
    { "real/first.ts": source, "real/second.ts": source },
    async (directory) => {
      await symlink(join(directory, "real"), join(directory, "alias"));
      const findings = await inspectClones([
        join(directory, "alias/first.ts"),
        join(directory, "alias/second.ts"),
      ]);
      assert.equal(findings[0]?.tokens, 150);
    },
  );
});
