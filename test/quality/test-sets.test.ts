import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseTestSet } from "../../quality/command.ts";
import { sourceFiles } from "../../quality/source-files.ts";
import { selectTestSet } from "../../quality/test-shards.ts";
import { withFiles } from "./files-fixture.ts";

const projectFiles = {
  "a.test.ts": "",
  "b.test.ts": "",
  "test/c.test.ts": "",
  "test/d.test.ts": "",
};

function inventory(directory: string): string[] {
  return Object.keys(projectFiles).map((file) => join(directory, file));
}

await test("CLOVING_TEST_SET takes all or platform, and all is the default", () => {
  assert.equal(parseTestSet(undefined), "all");
  assert.equal(parseTestSet("all"), "all");
  assert.equal(parseTestSet("platform"), "platform");
  for (const value of ["", "Platform", "full", "platform\n", " all"])
    assert.throws(() => parseTestSet(value), {
      message: "CLOVING_TEST_SET must be all or platform",
    });
});

await test("the platform set keeps only the test files of quality/platform-tests.json", async () => {
  await withFiles(
    {
      ...projectFiles,
      "quality/platform-tests.json": '["b.test.ts", "test/d.test.ts"]',
    },
    (directory) => {
      const tests = inventory(directory);
      assert.deepEqual(selectTestSet(directory, { tests, set: "platform" }), [
        join(directory, "b.test.ts"),
        join(directory, "test/d.test.ts"),
      ]);
      assert.deepEqual(selectTestSet(directory, { tests, set: "all" }), tests);
    },
  );
});

await test("the platform set refuses a listed file that is not in the test inventory", async () => {
  await withFiles(
    {
      ...projectFiles,
      "quality/platform-tests.json": '["a.test.ts", "test/gone.test.ts"]',
    },
    (directory) => {
      assert.throws(
        () =>
          selectTestSet(directory, {
            tests: inventory(directory),
            set: "platform",
          }),
        {
          message:
            "quality/platform-tests.json names a file that is not in the test inventory: test/gone.test.ts",
        },
      );
    },
  );
});

for (const [list, message] of [
  ['["b.test.ts", "a.test.ts"]', "must be sorted with no duplicates"],
  ['["a.test.ts", "a.test.ts"]', "must be sorted with no duplicates"],
  ['{"a.test.ts": true}', "must be a JSON array of paths"],
  ["[1]", "must be a JSON array of paths"],
] as const)
  await test(`the platform set refuses the list ${list}`, async () => {
    await withFiles(
      { ...projectFiles, "quality/platform-tests.json": list },
      (directory) => {
        assert.throws(
          () =>
            selectTestSet(directory, {
              tests: inventory(directory),
              set: "platform",
            }),
          { message: `quality/platform-tests.json ${message}` },
        );
      },
    );
  });

await test("the committed platform list names test files of the inventory, with each real-browser test", async () => {
  const directory = process.cwd();
  const tests = (await sourceFiles(directory)).filter((file) =>
    file.endsWith(".test.ts"),
  );
  const selected = selectTestSet(directory, { tests, set: "platform" });
  const browserTests: string[] = [];
  for (const name of await readdir("test"))
    if (
      name.endsWith(".test.ts") &&
      (await readFile(join("test", name), "utf8")).includes(
        'from "./watch-real-browser.ts"',
      )
    )
      browserTests.push(join(directory, "test", name));
  assert.ok(browserTests.length > 0);
  for (const file of browserTests) assert.ok(selected.includes(file), file);
});
