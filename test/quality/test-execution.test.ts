import assert from "node:assert/strict";
import childProcess from "node:child_process";
import filesystem from "node:fs";
import { readdir, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkTests, testCommand } from "../../quality/test-execution.ts";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";
import {
  assertTestFailure,
  failedOutput,
  retainedReport,
} from "./test-failure-fixture.ts";

await test("CLV-164 saves assertion diffs and stacks without expanding the failure list", async () => {
  await withFiles(
    {
      "assertion.test.ts":
        'import { test } from "node:test"; import assert from "node:assert/strict"; await test("deep assertion", () => { assert.deepStrictEqual({ value: "actual" }, { value: "expected" }); });',
    },
    async (directory) => {
      const result = await failedOutput(async () => {
        await checkTests(directory, {
          files: [join(directory, "assertion.test.ts")],
        });
      });
      const report = retainedReport(result.error);
      assert.match(report, /actual/);
      assert.match(report, /expected/);
      assert.match(report, /AssertionError/);
      assert.match(report, /TestContext/);
      assert.match(result.output, /^Failed tests:\ndeep assertion\n/);
      assert.equal(result.output.trimEnd().split("\n").length, 4);
    },
  );
});

await test("CLV-164 prints failed assertions and crashed files before rejecting", async () => {
  await withFiles(
    {
      "assertion.test.ts":
        'import { test } from "node:test"; import assert from "node:assert/strict"; await test("broken assertion", () => { assert.fail("assertion cause"); });',
      "crash.test.ts": 'console.error("file crash cause"); process.exit(1);',
    },
    async (directory) => {
      const result = await failedOutput(async () => {
        await checkTests(directory, {
          files: [
            join(directory, "assertion.test.ts"),
            join(directory, "crash.test.ts"),
          ],
        });
      });
      const report = retainedReport(result.error);
      assert.match(report, /broken assertion/);
      assert.match(report, /file crash cause/);
      const output = result.output;
      assert.match(output, /^Failed tests:\n/);
      assert.match(output, /broken assertion/);
      assert.match(output, /assertion cause/);
      assert.match(output, /assertion\.test\.ts:1:\d+/);
      assert.match(output, /crash\.test\.ts/);
      assert.match(output, /stderr:\n.*file crash cause/);
    },
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
      /CLOVING_CHECK_TIME_FACTOR.*whole number from 1 to 9/,
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
    const file = join(directory, "main.test.ts");
    const command = testCommand(directory, { tests: [file] });
    const result = childProcess.spawnSync(
      command.executable,
      command.arguments,
      {
        cwd: directory,
        encoding: "utf8",
        env: { PATH: process.env["PATH"], TZ: "UTC", CI: "true" },
        timeout: testMilliseconds(10000),
      },
    );
    assert.equal(result.status, 0);
    const failure = await failedOutput(async () => {
      await checkTests(directory, { files: [file] });
    });
    assert.equal(retainedReport(failure.error), result.stdout);
    assert.equal(
      failure.output,
      `Failed tests:\nunfinished\n  failure\n  at ${file}:1:133\n`,
    );
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
    await assertTestFailure(async () => {
      await checkTests(directory, { files: [join(directory, "main.test.ts")] });
    });
  });
});
