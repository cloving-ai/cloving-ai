import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import {
  assertCheckCoverage,
  checkProject,
  requiredChecks,
} from "../../quality/project.ts";
import { withFiles } from "./files-fixture.ts";

const valid =
  "export function double(value: number): number { return value * 2; }";
const testSource =
  'import assert from "node:assert/strict"; import { test } from "node:test"; import { double } from "./main.ts"; await test("doubles", () => { assert.equal(double(2), 4); });';

async function fixtureFiles(source: string): Promise<Record<string, string>> {
  return {
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
    "main.ts": await format(source, { parser: "typescript" }),
    "main.test.ts": await format(testSource, { parser: "typescript" }),
  };
}

await test("QG-01 executes every analyzer and the actual fixture test suite", async () => {
  await withFiles(await fixtureFiles(valid), async (directory) => {
    const result = await checkProject(directory);
    assert.equal(result.files.length, 2);
    assert.deepEqual(result.completed, requiredChecks);
  });
});

for (const [name, addition, message] of [
  [
    "typed lint",
    'export const unsafe = JSON.parse("1");',
    /no-unsafe-assignment/,
  ],
  [
    "structure",
    "export function identity(flag: boolean): boolean { return flag; }",
    /no-boolean-parameter/,
  ],
] as const) {
  await test(`QG-01 integrated ${name} rejection names its rule`, async () => {
    await withFiles(await fixtureFiles(valid + addition), async (directory) => {
      await assert.rejects(checkProject(directory), message);
    });
  });
}

await test("QG-01 rejects unformatted source and a failing behavior test", async () => {
  const unformatted = await fixtureFiles(valid);
  unformatted["main.ts"] = valid;
  await withFiles(unformatted, async (directory) => {
    await assert.rejects(checkProject(directory), /format/i);
  });
  const failing = await fixtureFiles(valid.replace("value * 2", "value * 3"));
  await withFiles(failing, async (directory) => {
    await assert.rejects(checkProject(directory), /Check exit 1/);
  });
});

await test("QG-10 rejects omitted checks and empty test discovery", async () => {
  assert.throws(() => {
    assertCheckCoverage(requiredChecks.slice(1));
  }, /missing or repeated/i);
  const files = await fixtureFiles(valid);
  delete files["main.test.ts"];
  await withFiles(files, async (directory) => {
    await assert.rejects(checkProject(directory), /empty test inventory/i);
  });
});

await test("QG-10 rejects a test file that declares no tests", async () => {
  const files = await fixtureFiles(valid);
  files["main.test.ts"] = "export {};\n";
  await withFiles(files, async (directory) => {
    await assert.rejects(checkProject(directory), /no completed tests/i);
  });
});
