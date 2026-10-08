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

async function checkFixture(directory: string) {
  return await checkProject(directory, {
    architecture: {
      roles: {
        [resolve(directory, "main.ts")]: "pure",
        [resolve(directory, "main.test.ts")]: "test",
        "node:test": "test-runtime",
        "node:assert/strict": "test-runtime",
      },
      allowed: { pure: ["pure"], test: ["pure", "test-runtime"] },
      forbiddenReachability: {},
    },
    stepExports: {},
  });
}

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
    const result = await checkFixture(directory);
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
      await assert.rejects(checkFixture(directory), message);
    });
  });
}

await test("QG-01 rejects unformatted source and a failing behavior test", async () => {
  const unformatted = await fixtureFiles(valid);
  unformatted["main.ts"] = valid;
  await withFiles(unformatted, async (directory) => {
    await assert.rejects(checkFixture(directory), /format/i);
  });
  const failing = await fixtureFiles(valid.replace("value * 2", "value * 3"));
  await withFiles(failing, async (directory) => {
    await assert.rejects(checkFixture(directory), /Check exit 1/);
  });
});

await test("QG-10 rejects omitted checks and empty test discovery", async () => {
  assert.throws(() => {
    assertCheckCoverage(requiredChecks.slice(1));
  }, /missing or repeated/i);
  const files = await fixtureFiles(valid);
  delete files["main.test.ts"];
  await withFiles(files, async (directory) => {
    await assert.rejects(checkFixture(directory), /empty test inventory/i);
  });
});

await test("QG-10 rejects a test file that declares no tests", async () => {
  const files = await fixtureFiles(valid);
  files["main.test.ts"] = "export {};\n";
  await withFiles(files, async (directory) => {
    await assert.rejects(checkFixture(directory), /no completed tests/i);
  });
});

await test("QG-08 integrated suppression inventory rejects a locally ineffective directive", async () => {
  await withFiles(
    await fixtureFiles(valid + "\n// eslint-disable\n"),
    async (directory) => {
      await assert.rejects(checkFixture(directory), /unapproved-suppression/);
    },
  );
});

await test("QG-07 compiler exclusions cannot conceal generated-header source", async () => {
  const files = await fixtureFiles(valid);
  files["dist/hidden.ts"] = "/* generated */ export const hidden = 1;\n";
  files["tsconfig.json"] = JSON.stringify({
    extends: resolve("tsconfig.json"),
    compilerOptions: {
      rootDir: ".",
      typeRoots: [resolve("node_modules/@types")],
    },
    include: ["main.ts", "main.test.ts"],
    exclude: ["dist"],
  });
  await withFiles(files, async (directory) => {
    await assert.rejects(
      checkFixture(directory),
      /Compiler inventory does not match/,
    );
  });
});

await test("QG-18 integrated checks reject conditional assertions before executing tests", async () => {
  const files = await fixtureFiles(valid);
  files["main.test.ts"] = await format(
    'import assert from "node:assert/strict"; import { test } from "node:test"; await test("conditional", () => { if (process.env["UNSET"]) assert.ok(false); });',
    { parser: "typescript" },
  );
  await withFiles(files, async (directory) => {
    await assert.rejects(checkFixture(directory), /conditional-test-evidence/);
  });
});

await test("QG-06 integrated architecture rejects an ambient effect in a mapped pure source", async () => {
  await withFiles(
    await fixtureFiles(valid + " export const stamp = Date.now();"),
    async (directory) => {
      await assert.rejects(
        checkProject(directory, {
          architecture: {
            roles: {
              [resolve(directory, "main.ts")]: "pure",
              [resolve(directory, "main.test.ts")]: "test",
              "node:test": "test-runtime",
              "node:assert/strict": "test-runtime",
            },
            allowed: { pure: ["pure"], test: ["pure", "test-runtime"] },
            forbiddenReachability: {},
          },
          stepExports: {},
        }),
        /restricted-effect/,
      );
    },
  );
});

await test("QG-18 integrated checks reject an untested production function", async () => {
  await withFiles(
    await fixtureFiles(
      valid +
        " export function untouched(value: number): number { return value + 3; }",
    ),
    async (directory) => {
      await assert.rejects(
        checkFixture(directory),
        /insufficient-production-coverage/,
      );
    },
  );
});
