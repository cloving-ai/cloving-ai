import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTimeWarnings,
  runCommand,
  runSupervisedCommand,
  type CheckTiming,
} from "../../quality/command.ts";
import { withFiles } from "./files-fixture.ts";

const command = {
  executable: process.execPath,
  directory: process.cwd(),
  timeoutMilliseconds: 1000,
};

for (const execute of [runCommand, runSupervisedCommand]) {
  await test(`${execute.name}: CLV-156 forwards test concurrency to check subprocesses`, async () => {
    const previous = process.env["CLOVING_TEST_CONCURRENCY"];
    process.env["CLOVING_TEST_CONCURRENCY"] = "3";
    try {
      assert.equal(
        await execute({
          ...command,
          arguments: [
            "-e",
            "process.stdout.write(process.env.CLOVING_TEST_CONCURRENCY ?? 'unset')",
          ],
        }),
        "3",
      );
    } finally {
      if (previous === undefined)
        delete process.env["CLOVING_TEST_CONCURRENCY"];
      else process.env["CLOVING_TEST_CONCURRENCY"] = previous;
    }
  });

  await test(`${execute.name}: QG-10 gives a check its explicit isolated home directory`, async () => {
    await withFiles({}, async (directory) => {
      const options = {
        ...command,
        homeDirectory: directory,
        arguments: ["-e", "process.stdout.write(require('node:os').homedir())"],
      };
      assert.equal(await execute(options), directory);
    });
  });

  await test(`${execute.name}: QG-10 reports actual successful command output`, async () => {
    assert.equal(
      await execute({
        ...command,
        arguments: ["-e", "process.stdout.write('verified')"],
      }),
      "verified",
    );
  });

  for (const scenario of [
    {
      name: "missing tool",
      options: { ...command, executable: "/not-a-cloving-tool", arguments: [] },
      message: /execution failed/,
    },
    {
      name: "nonzero exit",
      options: { ...command, arguments: ["-e", "process.exitCode = 7"] },
      message: /exit 7/,
    },
    {
      name: "timeout",
      options: {
        ...command,
        timeoutMilliseconds: 50,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
      },
      message: /execution failed.*limit 50 ms/,
    },
  ]) {
    await test(`${execute.name}: QG-10 rejects ${scenario.name}`, async () => {
      await assert.rejects(
        async () => await execute(scenario.options),
        scenario.message,
      );
    });
  }

  for (const elapsedMilliseconds of [300000, 480000, 480001]) {
    await test(`${execute.name}: CLV-152 warns strictly above 80 percent at ${String(elapsedMilliseconds)} ms`, async () => {
      const timings: CheckTiming[] = [];
      let tick = 123;
      assert.equal(
        await execute(
          {
            ...command,
            check: "tests",
            timeoutMilliseconds: 600000,
            arguments: ["-e", "process.stdout.write('passed')"],
          },
          {
            timings,
            clock: () => {
              const current = tick;
              tick += elapsedMilliseconds;
              return current;
            },
          },
        ),
        "passed",
      );
      assert.deepEqual(timings, [
        {
          check: "tests",
          elapsedMilliseconds,
          timeoutMilliseconds: 600000,
        },
      ]);
      assert.deepEqual(
        checkTimeWarnings(timings),
        elapsedMilliseconds > 480000
          ? ["tests used 480.001 s of 600 s (80 percent)"]
          : [],
      );
    });
  }

  await test(`${execute.name}: CLV-152 retains elapsed time and the limit when a command times out`, async () => {
    const timings: CheckTiming[] = [];
    let tick = 0;
    await assert.rejects(async () => {
      await execute(
        {
          ...command,
          check: "tests",
          timeoutMilliseconds: 50,
          arguments: ["-e", "setInterval(() => {}, 1000)"],
        },
        {
          timings,
          clock: () => {
            tick += 70;
            return tick;
          },
        },
      );
    }, /Check execution failed: tests \(limit 50 ms\)/);
    assert.deepEqual(timings, [
      {
        check: "tests",
        elapsedMilliseconds: 70,
        timeoutMilliseconds: 50,
      },
    ]);
  });
}
