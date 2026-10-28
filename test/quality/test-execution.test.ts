import assert from "node:assert/strict";
import childProcess from "node:child_process";
import filesystem from "node:fs";
import { readdir, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runSupervisedCommand } from "../../quality/command.ts";
import {
  checkTests,
  coverageCommand,
  parseCheckTimeFactor,
  parseTestConcurrency,
  testCommand,
  testConcurrency,
} from "../../quality/test-execution.ts";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";

await test("CLV-112 bounds test concurrency by available cores", () => {
  for (const [cores, concurrency] of [
    [1, 2],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 4],
    [24, 4],
  ] as const)
    assert.equal(testConcurrency(cores), concurrency);
});

await test("CLV-156 accepts only whole test concurrency settings from 1 to 8", () => {
  for (const cores of [1, 3, 4, 24])
    assert.equal(
      parseTestConcurrency(undefined, cores),
      testConcurrency(cores),
    );
  for (const value of ["1", "2", "3", "4", "5", "6", "7", "8"])
    assert.equal(parseTestConcurrency(value, 3), Number(value));
  for (const value of ["0", "9", "x", "2.5", "-1", "", " 3", "3 ", "03", "3\n"])
    assert.throws(
      () => parseTestConcurrency(value, 3),
      /CLOVING_TEST_CONCURRENCY must be a whole number from 1 to 8/,
    );
});

await test("CLV-101 bounds retries for transient coverage cleanup errors", async () => {
  const remove = filesystem.rmSync;
  let removals = 0;
  filesystem.rmSync = (path, options) => {
    removals += 1;
    remove(path, options);
    assert.ok(options);
    assert.equal(options.recursive, true);
    assert.ok((options.maxRetries ?? 0) > 0);
    assert.ok((options.maxRetries ?? Infinity) <= 5);
    assert.ok((options.retryDelay ?? 100) > 0);
    assert.ok((options.retryDelay ?? 100) <= 1000);
    assert.equal(filesystem.existsSync(path), false);
  };
  syncBuiltinESMExports();
  try {
    await withFiles(
      {
        "main.test.ts":
          'import { test } from "node:test"; await test("passes", () => {});',
      },
      async (directory) => {
        await checkTests(directory, {
          files: [join(directory, "main.test.ts")],
        });
        assert.equal(removals, 1);
      },
    );
  } finally {
    filesystem.rmSync = remove;
    syncBuiltinESMExports();
  }
});

await test("CLV-101 fails the gate when coverage cleanup exhausts its retries", async () => {
  const remove = filesystem.rmSync;
  const failure = Object.assign(new Error("coverage directory still busy"), {
    code: "ENOTEMPTY",
  });
  filesystem.rmSync = (path, options) => {
    remove(path, options);
    throw failure;
  };
  syncBuiltinESMExports();
  try {
    await withFiles(
      {
        "main.test.ts":
          'import { test } from "node:test"; await test("passes", () => {});',
      },
      async (directory) => {
        await assert.rejects(
          async () => {
            await checkTests(directory, {
              files: [join(directory, "main.test.ts")],
            });
          },
          (error) => error === failure,
        );
      },
    );
  } finally {
    filesystem.rmSync = remove;
    syncBuiltinESMExports();
  }
});

await test("CLV-099 accepts only whole check time factors from 1 to 5", () => {
  assert.equal(parseCheckTimeFactor(undefined), 1);
  for (const value of ["1", "2", "3", "4", "5"])
    assert.equal(parseCheckTimeFactor(value), Number(value));
  for (const value of [
    "0",
    "6",
    "1.5",
    "-1",
    "3x",
    "",
    " ",
    " 3",
    "3 ",
    "03",
    "3\n",
  ])
    assert.throws(
      () => parseCheckTimeFactor(value),
      /CLOVING_CHECK_TIME_FACTOR.*whole number from 1 to 5/,
    );
});

await test("CLV-099 rejects an invalid time factor before the first gate check", async () => {
  await withFiles({ "package.json": "npm-check-must-not-run" }, (directory) => {
    const result = childProcess.spawnSync(
      process.execPath,
      [resolve("tools/check-quality.ts")],
      {
        cwd: directory,
        env: { ...process.env, CLOVING_CHECK_TIME_FACTOR: "0" },
        encoding: "utf8",
        timeout: testMilliseconds(10000),
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /CLOVING_CHECK_TIME_FACTOR.*whole number from 1 to 5/,
    );
    assert.equal(result.stdout, "");
  });
});

await test("CLV-048 excludes the authority opening benchmark from the regular suite", async () => {
  const benchmarks = (await readdir(join(import.meta.dirname, ".."))).filter(
    (file) => file.startsWith("authority-opening-scale."),
  );
  assert.equal(benchmarks.length, 1);
  const benchmark = benchmarks[0];
  assert.ok(benchmark);
  const files = {
    "main.test.ts":
      'import { test } from "node:test"; await test("regular suite", () => {});',
    [benchmark]: 'throw new Error("benchmark ran in the regular suite");',
  };
  await withFiles(files, async (directory) => {
    await assert.doesNotReject(async () => {
      await checkTests(directory, {
        files: Object.keys(files).map((file) => join(directory, file)),
      });
    });
  });
});

await test("QG-10 matches executed test coverage through canonical paths", async () => {
  const source =
    'import { test } from "node:test"; import assert from "node:assert/strict"; await test("value", () => { assert.equal(1, 1); });';
  await withFiles({ "real.test.ts": source }, async (directory) => {
    const alias = join(directory, "alias.test.ts");
    await symlink(join(directory, "real.test.ts"), alias);
    await assert.doesNotReject(async () => {
      await checkTests(directory, { files: [alias] });
    });
  });
});

for (const skipped of [
  'test.skip("hidden", () => {});',
  'test.todo("unfinished");',
  'test("conditional", { skip: true }, () => {});',
  'test("runtime", (context) => { context.skip(); });',
]) {
  await test(`QG-18 rejects skipped work even beside a passing test: ${skipped}`, async () => {
    const source = `import { test } from "node:test"; await test("passing", () => {}); ${skipped}`;
    await withFiles({ "mixed.test.ts": source }, async (directory) => {
      await assert.rejects(async () => {
        await checkTests(directory, {
          files: [join(directory, "mixed.test.ts")],
        });
      }, /skipped-mandatory-test/);
    });
  });
}

await test("QG-18 requires coverage for every declared production source", async () => {
  const files = {
    "package.json": '{"type":"module"}',
    "main.ts": "export const value = 1;",
    "main.test.ts":
      'import { test } from "node:test"; import assert from "node:assert/strict"; await test("passes", () => { assert.equal(1, 1); });',
  };
  await withFiles(files, async (directory) => {
    const inventory = [
      join(directory, "main.ts"),
      join(directory, "main.test.ts"),
    ];
    await assert.rejects(async () => {
      await checkTests(directory, {
        files: inventory,
        coverageFiles: [join(directory, "main.ts")],
      });
    }, /missing-production-coverage/);
  });
  files["main.test.ts"] =
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("passes", () => { assert.equal(value, 1); });';
  await withFiles(files, async (directory) => {
    const inventory = [
      join(directory, "main.ts"),
      join(directory, "main.test.ts"),
    ];
    await assert.doesNotReject(async () => {
      await checkTests(directory, {
        files: inventory,
        coverageFiles: [join(directory, "main.ts")],
      });
    });
  });
});

await test("QG-18 rejects failing TODO events even when the runner exits successfully", async () => {
  const source =
    'import { test } from "node:test"; import assert from "node:assert/strict"; await test("passing", () => { assert.ok(true); }); await test("unfinished", { todo: true }, () => { assert.fail("failure"); });';
  await withFiles({ "main.test.ts": source }, async (directory) => {
    await assert.rejects(async () => {
      await checkTests(directory, { files: [join(directory, "main.test.ts")] });
    }, /test-report-failure/);
  });
});

await test("QG-18 compares completed test identities with an external mandatory inventory", async () => {
  const source =
    'import { test } from "node:test"; await test("first", () => {});';
  await withFiles({ "main.test.ts": source }, async (directory) => {
    const file = join(directory, "main.test.ts");
    await assert.rejects(async () => {
      await checkTests(directory, {
        files: [file],
        requiredTests: { [file]: ["first", "removed"] },
      });
    }, /mandatory-test-inventory-mismatch/);
    await assert.doesNotReject(async () => {
      await checkTests(directory, {
        files: [file],
        requiredTests: { [file]: ["first"] },
      });
    });
  });
});

await test("QG-18 rejects an unhandled rejection from an otherwise passing test", async () => {
  const source =
    'import { test } from "node:test"; await test("unhandled", () => { void Promise.reject(new Error("unhandled fixture")); });';
  await withFiles({ "main.test.ts": source }, async (directory) => {
    await assert.rejects(async () => {
      await checkTests(directory, { files: [join(directory, "main.test.ts")] });
    }, /Check exit 1/);
  });
});

await test("CLV-044 the developer gate gives its test command a 600 s bound", () => {
  const command = testCommand("/project", {
    tests: ["/project/main.test.ts"],
  });
  assert.equal(command.timeoutMilliseconds, 600000);
  assert.deepEqual(command.arguments.slice(-1), ["/project/main.test.ts"]);
  assert.equal(command.directory, "/project");
});

await test("CLV-156 the test command uses the configured worker count", () => {
  const previous = process.env["CLOVING_TEST_CONCURRENCY"];
  process.env["CLOVING_TEST_CONCURRENCY"] = "3";
  try {
    const command = testCommand("/project", {
      tests: ["/project/main.test.ts"],
    });
    assert.ok(command.arguments.includes("--test-concurrency=3"));
    assert.equal(command.timeoutMilliseconds, 600000);
  } finally {
    if (previous === undefined) delete process.env["CLOVING_TEST_CONCURRENCY"];
    else process.env["CLOVING_TEST_CONCURRENCY"] = previous;
  }
});

await test("CLV-099 scales the test command bound by the check time factor", () => {
  const previous = process.env["CLOVING_TEST_CONCURRENCY"];
  delete process.env["CLOVING_TEST_CONCURRENCY"];
  try {
    for (const [timeFactor, timeout] of [
      [1, 600000],
      [3, 1800000],
    ] as const) {
      const command = testCommand("/project", {
        tests: ["/project/main.test.ts"],
        timeFactor,
      });
      assert.equal(command.timeoutMilliseconds, timeout);
      assert.deepEqual(
        command.arguments.filter((argument) =>
          argument.startsWith("--test-concurrency="),
        ),
        [
          `--test-concurrency=${String(testConcurrency(availableParallelism()))}`,
        ],
      );
    }
  } finally {
    if (previous !== undefined)
      process.env["CLOVING_TEST_CONCURRENCY"] = previous;
  }
});

await test("CLV-099 scales the coverage command bound by the check time factor", () => {
  const run = { coverageDirectory: "/coverage", files: ["/project/main.ts"] };
  assert.equal(coverageCommand("/project", run).timeoutMilliseconds, 60000);
  for (const [timeFactor, timeout] of [
    [1, 60000],
    [3, 180000],
  ] as const) {
    const command = coverageCommand("/project", { ...run, timeFactor });
    assert.equal(command.timeoutMilliseconds, timeout);
    assert.deepEqual(command.arguments.slice(1), [
      "/coverage",
      "/project/main.ts",
    ]);
    assert.equal(command.directory, "/project");
  }
});

await test("CLV-044 a test run that is longer than its bound fails the test command", async () => {
  const source =
    'import { test } from "node:test"; import { setTimeout as delay } from "node:timers/promises"; await test("slow", async () => { await delay(2000); });';
  await withFiles({ "slow.test.ts": source }, async (directory) => {
    const command = testCommand(directory, {
      tests: [join(directory, "slow.test.ts")],
    });
    await assert.rejects(async () => {
      await runSupervisedCommand({ ...command, timeoutMilliseconds: 50 });
    }, /execution failed/);
  });
});
