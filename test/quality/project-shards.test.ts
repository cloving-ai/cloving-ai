import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import { checkProject, requiredChecks } from "../../quality/project.ts";
import { withFiles } from "./files-fixture.ts";

for (const shard of ["1/2", "2/2"]) {
  await test(`CLV-266 shard ${shard} runs its tests and only shard 1 runs static checks`, async () => {
    const source =
      'import assert from "node:assert/strict"; import { test } from "node:test"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });';
    const files = {
      "package.json": '{"type":"module"}',
      "tsconfig.json": JSON.stringify({
        extends: resolve("tsconfig.json"),
        compilerOptions: {
          rootDir: ".",
          typeRoots: [resolve("node_modules/@types")],
        },
        include: ["**/*"],
        exclude: [],
      }),
      "main.ts": await format("export const value = 1;", {
        parser: "typescript",
      }),
      "a.test.ts": await format(source, { parser: "typescript" }),
      "b.test.ts": await format(source.replace('"value",', '"second",'), {
        parser: "typescript",
      }),
    };
    await withFiles(files, async (directory) => {
      const result = await checkProject(directory, {
        shard,
        coverageDirectory: join(directory, "exported"),
        architecture: {
          roles: {
            [join(directory, "main.ts")]: "pure",
            [join(directory, "a.test.ts")]: "test",
            [join(directory, "b.test.ts")]: "test",
            "node:test": "test-runtime",
            "node:assert/strict": "test-runtime",
          },
          allowed: { pure: ["pure"], test: ["pure", "test-runtime"] },
          forbiddenReachability: {},
        },
        stepExports: {},
      });
      assert.deepEqual(
        result.completed,
        shard === "1/2" ? requiredChecks : ["tests"],
      );
      assert.deepEqual(
        result.timings.map((entry) => entry.check),
        shard === "1/2" ? ["clones", "tests"] : ["tests"],
      );
    });
  });
}
