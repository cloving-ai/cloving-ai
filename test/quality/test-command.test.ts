import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSupervisedCommand } from "../../quality/command.ts";
import {
  coverageCommand,
  parseCheckTimeFactor,
  parseTestConcurrency,
  testCommand,
  testConcurrency,
} from "../../quality/test-execution.ts";
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

await test("CLV-044 the developer gate gives its test command a 600 s bound", () => {
  const command = testCommand("/project", {
    tests: ["/project/main.test.ts"],
  });
  assert.equal(command.timeoutMilliseconds, 600000);
  assert.deepEqual(command.acceptedExitCodes, [0, 1]);
  assert.deepEqual(command.arguments.slice(-1), ["/project/main.test.ts"]);
  assert.equal(command.directory, "/project");
});

await test("CLV-164 duration recording keeps failed exit codes rejected", () => {
  const command = testCommand("/project", {
    tests: ["/project/main.test.ts"],
    reporter: "durations",
  });
  assert.deepEqual(command.acceptedExitCodes, [0]);
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
