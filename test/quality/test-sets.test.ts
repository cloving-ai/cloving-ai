import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseChangedPaths, parseTestSet } from "../../quality/command.ts";
import { sourceFiles } from "../../quality/source-files.ts";
import {
  selectChangedTests,
  selectTestSet,
} from "../../quality/test-shards.ts";
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

const mainOnlyFiles = {
  ...projectFiles,
  "quality/main-only-tests.json": JSON.stringify([
    { files: ["a.test.ts"], triggers: ["a.test.ts", "package.json", "tools/"] },
    {
      files: ["test/c.test.ts", "test/d.test.ts"],
      triggers: ["quality/", "test/"],
    },
  ]),
};

await test("a pull request leaves out each main-only test when no changed path matches its triggers, and names the reason", async () => {
  await withFiles(mainOnlyFiles, (directory) => {
    assert.deepEqual(
      selectChangedTests(directory, {
        inventory: inventory(directory),
        tests: inventory(directory),
        changedPaths: ["src/cli/watch-view.ts", "README.md"],
      }),
      {
        tests: [join(directory, "b.test.ts")],
        leftOut: [
          {
            file: "a.test.ts",
            reason:
              "no changed path matches its triggers: a.test.ts, package.json, tools/",
          },
          {
            file: "test/c.test.ts",
            reason: "no changed path matches its triggers: quality/, test/",
          },
          {
            file: "test/d.test.ts",
            reason: "no changed path matches its triggers: quality/, test/",
          },
        ],
      },
    );
  });
});

for (const [changed, kept] of [
  [["package.json"], ["a.test.ts", "b.test.ts"]],
  [["tools/check-quality.ts"], ["a.test.ts", "b.test.ts"]],
  [["a.test.ts"], ["a.test.ts", "b.test.ts"]],
  [["quality/project.ts"], ["b.test.ts", "test/c.test.ts", "test/d.test.ts"]],
  [["package.json", "test/e.ts"], Object.keys(projectFiles)],
] as const)
  await test(`a pull request that changes ${changed.join(" and ")} runs the main-only tests of the matched triggers`, async () => {
    await withFiles(mainOnlyFiles, (directory) => {
      const selected = selectChangedTests(directory, {
        inventory: inventory(directory),
        tests: inventory(directory),
        changedPaths: changed,
      });
      assert.deepEqual(
        selected.tests,
        kept.map((file) => join(directory, file)),
      );
      assert.deepEqual(
        selected.leftOut.map((entry) => entry.file),
        Object.keys(projectFiles).filter(
          (file) => !kept.some((name) => name === file),
        ),
      );
    });
  });

await test("a pull request checks the list against the whole inventory, and reports only the left-out files of the selected set", async () => {
  await withFiles(mainOnlyFiles, (directory) => {
    assert.deepEqual(
      selectChangedTests(directory, {
        inventory: inventory(directory),
        tests: [
          join(directory, "b.test.ts"),
          join(directory, "test/c.test.ts"),
        ],
        changedPaths: ["README.md"],
      }),
      {
        tests: [join(directory, "b.test.ts")],
        leftOut: [
          {
            file: "test/c.test.ts",
            reason: "no changed path matches its triggers: quality/, test/",
          },
        ],
      },
    );
  });
});

await test("a run with no changed paths, as on main or in the merge queue, runs every test file and reads no list", async () => {
  await withFiles(projectFiles, (directory) => {
    assert.deepEqual(
      selectChangedTests(directory, {
        inventory: inventory(directory),
        tests: inventory(directory),
        changedPaths: undefined,
      }),
      { tests: inventory(directory), leftOut: [] },
    );
  });
});

for (const [list, message] of [
  ["{}", "must be a JSON array of groups with files and triggers"],
  [
    '[{"files": ["a.test.ts"]}]',
    "must be a JSON array of groups with files and triggers",
  ],
  [
    '[{"files": ["a.test.ts"], "triggers": [1]}]',
    "must be a JSON array of groups with files and triggers",
  ],
  [
    '[{"files": [], "triggers": ["a.test.ts"]}]',
    "must give each group files and triggers",
  ],
  [
    '[{"files": ["a.test.ts"], "triggers": [""]}]',
    "must give each group files and triggers",
  ],
  [
    '[{"files": ["b.test.ts", "a.test.ts"], "triggers": ["a", "b"]}]',
    "must keep files and triggers sorted with no duplicates",
  ],
  [
    '[{"files": ["a.test.ts"], "triggers": ["a", "a"]}]',
    "must keep files and triggers sorted with no duplicates",
  ],
  [
    '[{"files": ["a.test.ts"], "triggers": ["a"]}, {"files": ["a.test.ts"], "triggers": ["a"]}]',
    "names a file two times: a.test.ts",
  ],
  [
    '[{"files": ["gone.test.ts"], "triggers": ["gone"]}]',
    "names a file that is not in the test inventory: gone.test.ts",
  ],
  [
    '[{"files": ["a.test.ts"], "triggers": ["quality/"]}]',
    "names a file that its own triggers do not match: a.test.ts",
  ],
] as const)
  await test(`the main-only list refuses ${list}`, async () => {
    await withFiles(
      { ...projectFiles, "quality/main-only-tests.json": list },
      (directory) => {
        assert.throws(
          () =>
            selectChangedTests(directory, {
              inventory: inventory(directory),
              tests: inventory(directory),
              changedPaths: ["README.md"],
            }),
          { message: `quality/main-only-tests.json ${message}` },
        );
      },
    );
  });

await test("the changed paths are the NUL-separated output of git diff -z", () => {
  assert.deepEqual(parseChangedPaths(""), []);
  assert.deepEqual(parseChangedPaths("package.json\0src/a b.ts\0"), [
    "package.json",
    "src/a b.ts",
  ]);
  for (const text of ["\0", "a\0\0b\0", "/etc/passwd\0", "a\nb\0"])
    assert.throws(() => parseChangedPaths(text), {
      message:
        "CLOVING_CHANGED_PATHS must name a file of NUL-separated relative paths",
    });
});

await test("the committed main-only list leaves out the packed install and the slow gate tests for a change outside their triggers", async () => {
  const directory = process.cwd();
  const tests = (await sourceFiles(directory)).filter((file) =>
    file.endsWith(".test.ts"),
  );
  const gateTests = [
    "test/quality/coverage-volume.test.ts",
    "test/quality/project.test.ts",
    "test/quality/quality-output.test.ts",
    "test/quality/worker-hooks.test.ts",
  ];
  const leftOut = (changedPaths: readonly string[] | undefined) =>
    selectChangedTests(directory, {
      inventory: tests,
      tests,
      changedPaths,
    }).leftOut.map((entry) => entry.file);
  assert.deepEqual(leftOut(["src/cli/watch-view.ts"]), [
    "test/packed-install.test.ts",
    ...gateTests,
  ]);
  assert.deepEqual(leftOut(["package.json"]), gateTests);
  assert.deepEqual(leftOut(["package-lock.json"]), gateTests);
  assert.deepEqual(leftOut(["quality/project.ts"]), [
    "test/packed-install.test.ts",
  ]);
  assert.deepEqual(leftOut([".github/workflows/ci.yml"]), [
    "test/packed-install.test.ts",
  ]);
  assert.deepEqual(leftOut(["tools/check-quality.ts"]), []);
  assert.deepEqual(leftOut(undefined), []);
});
