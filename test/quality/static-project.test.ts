import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import {
  checkProject,
  checkProjectSources,
  requiredChecks,
} from "../../quality/project.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-09 trusted static checks inspect candidate tests without executing them", async () => {
  await withFiles(
    {
      "main.ts": "export const value = 1;\n",
      "main.test.ts": await format(
        'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 2); });',
        { parser: "typescript" },
      ),
      "package.json": '{"type":"module"}',
    },
    async (directory) => {
      const policy = {
        trustedCompilerConfiguration: resolve("tsconfig.json"),
        architecture: {
          roles: {
            [join(directory, "main.ts")]: "pure",
            [join(directory, "main.test.ts")]: "test",
            "node:test": "stdlib",
            "node:assert/strict": "stdlib",
          },
          allowed: { pure: ["pure"], test: ["pure", "stdlib"] },
          forbiddenReachability: {},
        },
        stepExports: {},
      };
      const result = await checkProjectSources(directory, policy);
      assert.deepEqual(
        result.completed,
        requiredChecks.filter((name) => name !== "tests"),
      );
      await assert.rejects(checkProject(directory, policy), /Check exit 1/);
    },
  );
});
