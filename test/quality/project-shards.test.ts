import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import {
  checkProject,
  checkProjectTestShard,
  requiredChecks,
  writeProjectReport,
} from "../../quality/project.ts";
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

await test("the platform set runs only the listed tests of its shard", async () => {
  const passing =
    'import assert from "node:assert/strict"; import { test } from "node:test"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });';
  const files = {
    "package.json": '{"type":"module"}',
    "main.ts": "export const value = 1;\n",
    "a.test.ts": passing.replace("value, 1", "value, 2"),
    "b.test.ts": passing,
    "c.test.ts": passing.replace("value, 1", "value, 3"),
    "quality/platform-tests.json": '["b.test.ts"]',
  };
  await withFiles(files, async (directory) => {
    const options = {
      shard: "1/1",
      coverage: "off",
      architecture: {
        roles: {
          [join(directory, "main.ts")]: "pure",
          [join(directory, "a.test.ts")]: "test",
          [join(directory, "b.test.ts")]: "test",
          [join(directory, "c.test.ts")]: "test",
        },
        allowed: {},
        forbiddenReachability: {},
      },
      stepExports: {},
    } as const;
    const result = await checkProjectTestShard(directory, {
      ...options,
      testSet: "platform",
    });
    assert.deepEqual(result.completed, ["tests"]);
    await assert.rejects(
      checkProjectTestShard(directory, { ...options, testSet: "all" }),
      /test-report-failure/,
    );
  });
});

await test("a pull request shard leaves out a main-only test that no changed path matches, and its report names the file and the reason", async () => {
  const passing =
    'import assert from "node:assert/strict"; import { test } from "node:test"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });';
  const files = {
    "package.json": '{"type":"module"}',
    "main.ts": "export const value = 1;\n",
    "a.test.ts": passing.replace("value, 1", "value, 2"),
    "b.test.ts": passing,
    "quality/main-only-tests.json": JSON.stringify([
      { files: ["a.test.ts"], triggers: ["a.test.ts", "package.json"] },
    ]),
  };
  await withFiles(files, async (directory) => {
    const options = {
      shard: "1/1",
      coverage: "off",
      architecture: {
        roles: {
          [join(directory, "main.ts")]: "pure",
          [join(directory, "a.test.ts")]: "test",
          [join(directory, "b.test.ts")]: "test",
        },
        allowed: {},
        forbiddenReachability: {},
      },
      stepExports: {},
    } as const;
    const result = await checkProjectTestShard(directory, {
      ...options,
      changedPaths: ["src/cli/watch-view.ts"],
    });
    assert.deepEqual(result.completed, ["tests"]);
    const leftOut = [
      {
        file: "a.test.ts",
        reason: "no changed path matches its triggers: a.test.ts, package.json",
      },
    ];
    assert.deepEqual(result.leftOut, leftOut);
    for (const changedPaths of [["package.json"], undefined])
      await assert.rejects(
        checkProjectTestShard(directory, {
          ...options,
          ...(changedPaths === undefined ? {} : { changedPaths }),
        }),
        /test-report-failure/,
      );
  });
});

await test("the project report prints a line for each test file that the gate left out", () => {
  const leftOut = [
    {
      file: "a.test.ts",
      reason: "no changed path matches its triggers: a.test.ts, package.json",
    },
  ];
  const written = { stdout: "", stderr: "" };
  writeProjectReport(
    { timings: [], warnings: [], leftOut },
    {
      stdout: { write: (text) => Boolean((written.stdout += text)) },
      stderr: { write: (text) => Boolean((written.stderr += text)) },
    },
  );
  assert.deepEqual(JSON.parse(written.stdout), {
    timings: [],
    warnings: [],
    leftOut,
  });
  assert.equal(
    written.stderr,
    "Left out a.test.ts: no changed path matches its triggers: a.test.ts, package.json\n",
  );
});
