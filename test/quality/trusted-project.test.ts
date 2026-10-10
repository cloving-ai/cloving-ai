import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import { compilerProgram } from "../../quality/compiler.ts";
import { checkProject, requiredChecks } from "../../quality/project.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-09 trusted compiler options ignore candidate weakening", async () => {
  await withFiles(
    {
      "main.ts": "export const value = 1;\n",
      "package.json": '{"type":"module"}',
      "tsconfig.json":
        '{"compilerOptions":{"strict":false},"include":["main.ts"]}',
    },
    (directory) => {
      const program = compilerProgram(directory, {
        files: [join(directory, "main.ts")],
        trustedConfiguration: resolve("tsconfig.json"),
      });
      assert.equal(program.getCompilerOptions().strict, true);
      assert.equal(program.getCompilerOptions().noUncheckedIndexedAccess, true);
    },
  );
});

await test("QG-01 trusted project completes its declared checks on valid candidate code", async () => {
  await withFiles(
    {
      "main.ts": "export const value = 1;\n",
      "main.test.ts": await format(
        'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });',
        { parser: "typescript" },
      ),
      "package.json": '{"type":"module"}',
      "tsconfig.json": '{"compilerOptions":{"strict":false},"include":[]}',
    },
    async (directory) => {
      const result = await checkProject(directory, {
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
        requiredTests: { [join(directory, "main.test.ts")]: ["value"] },
      });
      assert.deepEqual(result.completed, requiredChecks);
    },
  );
});

await test("QG-09 pinned project checks reject forbidden code despite replacement scripts and configuration", async () => {
  const source = await format(
    "export function forbidden(value: boolean): boolean { return value; }",
    { parser: "typescript" },
  );
  await withFiles(
    {
      "main.ts": source,
      "main.test.ts": "export {};\n",
      "tsconfig.json":
        '{"compilerOptions":{"strict":false},"include":["main.test.ts"]}',
      "package.json": '{"type":"module"}',
      "eslint.config.mjs": 'throw new Error("candidate-checker-executed");\n',
    },
    async (directory) => {
      const marker = join(directory, "executed");
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            check: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")'`,
          },
        }),
      );
      await assert.rejects(
        checkProject(directory, {
          trustedCompilerConfiguration: resolve("tsconfig.json"),
          architecture: {
            roles: {
              [join(directory, "main.ts")]: "pure",
              [join(directory, "main.test.ts")]: "test",
              [join(directory, "eslint.config.mjs")]: "configuration",
            },
            allowed: { pure: ["pure"], test: ["pure"], configuration: [] },
            forbiddenReachability: {},
          },
          stepExports: {},
        }),
        /no-boolean-parameter/,
      );
      await assert.rejects(access(marker), /ENOENT/);
    },
  );
});
