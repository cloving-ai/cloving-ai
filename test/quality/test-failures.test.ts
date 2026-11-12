import assert from "node:assert/strict";
import filesystem from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import operatingSystem from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reportTestFailures } from "../../quality/test-failures.ts";
import { failedOutput, retainedReport } from "./test-failure-fixture.ts";
import { withFiles } from "./files-fixture.ts";

await test("CLV-164 retains at most 20 reports and removes reports older than a day", async () => {
  const names = Array.from(
    { length: 22 },
    () => `cloving-test-report-${randomUUID()}.json`,
  );
  const stale = `cloving-test-report-${randomUUID()}.json`;
  const unrelated = "cloving-test-report-unrelated.json";
  await withFiles(
    Object.fromEntries(
      [...names, stale, unrelated].map((name) => [name, "{}"]),
    ),
    async (directory) => {
      const now = Date.now();
      for (const [index, name] of names.entries()) {
        const date = new Date(now - (22 - index) * 1000);
        filesystem.utimesSync(join(directory, name), date, date);
      }
      const old = new Date(now - 25 * 60 * 60 * 1000);
      filesystem.utimesSync(join(directory, stale), old, old);
      const temporaryDirectory = operatingSystem.tmpdir;
      operatingSystem.tmpdir = () => directory;
      syncBuiltinESMExports();
      try {
        const result = await failedOutput(() => {
          reportTestFailures(
            { failures: [{ name: "failed", message: "cause", stderr: [] }] },
            '{"full":"report"}',
          );
        });
        const kept = filesystem.readdirSync(directory);
        assert.equal(kept.length, 21);
        assert.equal(filesystem.existsSync(join(directory, stale)), false);
        assert.deepEqual(
          names.map((name) => kept.includes(name)),
          [false, false, false, ...Array<boolean>(19).fill(true)],
        );
        assert.equal(kept.includes(unrelated), true);
        assert.equal(retainedReport(result.error), '{"full":"report"}');
      } finally {
        operatingSystem.tmpdir = temporaryDirectory;
        syncBuiltinESMExports();
      }
    },
  );
});

await test("CLV-164 retains the full report in a private temporary file", async () => {
  const report = {
    completed: 1,
    files: ["test.ts"],
    failures: [{ name: "failed", message: "cause", stderr: [] }],
    coverage: [{ path: "source.ts", lines: 90 }],
    identities: ["passed"],
  };
  const first = await failedOutput(() => {
    reportTestFailures(report, JSON.stringify(report));
  });
  const second = await failedOutput(() => {
    reportTestFailures(report, JSON.stringify(report));
  });
  assert.equal(first.output, "Failed tests:\nfailed\n  cause\n");
  assert.equal(second.output, first.output);
  assert.notEqual(first.error.message, second.error.message);
  assert.equal(retainedReport(first.error), JSON.stringify(report));
  assert.equal(retainedReport(second.error), JSON.stringify(report));
});

await test("CLV-164 cleanup refusals do not prevent saving the current failure", async () => {
  const name = `cloving-test-report-${randomUUID()}.json`;
  await withFiles({ [name]: "{}" }, async (directory) => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    filesystem.utimesSync(join(directory, name), old, old);
    const remove = filesystem.unlinkSync;
    const temporaryDirectory = operatingSystem.tmpdir;
    filesystem.unlinkSync = () => {
      throw Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
      });
    };
    operatingSystem.tmpdir = () => directory;
    syncBuiltinESMExports();
    try {
      const result = await failedOutput(() => {
        reportTestFailures(
          { failures: [{ name: "failed", message: "cause", stderr: [] }] },
          '{"full":"current report"}',
        );
      });
      assert.equal(retainedReport(result.error), '{"full":"current report"}');
      assert.equal(filesystem.existsSync(join(directory, name)), true);
    } finally {
      filesystem.unlinkSync = remove;
      operatingSystem.tmpdir = temporaryDirectory;
      syncBuiltinESMExports();
    }
  });
});

await test("CLV-164 bounds the list to 200 lines and each line to 500 characters", async () => {
  const report = {
    failures: Array.from({ length: 250 }, (_, index) => ({
      name: `failure ${String(index)} ${"n".repeat(600)}\nextra name`,
      message: "m".repeat(600),
      file: `${"f".repeat(600)}\nextra file`,
      line: 12,
      column: 34,
      stderr: [],
    })),
  };
  const result = await failedOutput(() => {
    reportTestFailures(report, JSON.stringify(report));
  });
  const lines = result.output.trimEnd().split("\n");
  assert.equal(lines.length, 200);
  assert.ok(lines.every((line) => line.length <= 500));
  assert.equal(lines[199], "184 failures not shown.");
  assert.doesNotMatch(result.output, /extra (?:name|file)/);
  assert.equal(retainedReport(result.error), JSON.stringify(report));
});

await test("CLV-164 passing reports print no failures and write no report file", () => {
  const writeFile = filesystem.writeFileSync;
  const writeOutput = process.stderr.write.bind(process.stderr);
  let writes = 0;
  let outputs = 0;
  filesystem.writeFileSync = () => {
    writes += 1;
  };
  process.stderr.write = () => {
    outputs += 1;
    return true;
  };
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => {
      reportTestFailures({ failures: [] }, '{"failures":[]}');
    });
    assert.equal(writes, 0);
    assert.equal(outputs, 0);
  } finally {
    filesystem.writeFileSync = writeFile;
    process.stderr.write = writeOutput;
    syncBuiltinESMExports();
  }
});

function assertionMessage(assertion: () => void): string {
  let message = "";
  assert.throws(assertion, (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    message = error.message;
    return true;
  });
  return message;
}

async function failureOutput(failures: readonly object[]): Promise<string> {
  const report = {
    failures: failures.map((failure) => ({ stderr: [], ...failure })),
  };
  const result = await failedOutput(() => {
    reportTestFailures(report, JSON.stringify(report));
  });
  assert.equal(retainedReport(result.error), JSON.stringify(report));
  return result.output;
}

await test("CLV-353 shows the error line and the first scenario location after log lines", async () => {
  const message = [
    "retention: removed 0 work trees, kept 0 with an open pull request",
    "queue: 1 ticket waits",
    "lanes: 1 of 1 in use",
    "Error: queue-condition-not-reached",
    "    at read (file:///work/node_modules/scenario/index.js:4:9)",
    "    at async file:///tmp/cloving-host-1/scenario.mjs:71:9",
    "    at async file:///tmp/cloving-host-1/scenario.mjs:120:3",
    "",
    "Node.js v26.9.0",
  ].join("\n");
  const assertion = [
    "lanes: 1 of 1 in use",
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "",
    "1 !== 2",
    "",
    "    at TestContext.<anonymous> (file:///work/test/queue.test.ts:40:5)",
    "    at Test.runInAsyncScope (node:async_hooks:214:14)",
  ].join("\n");
  assert.equal(
    await failureOutput([
      { name: "queue scene", message },
      { name: "queue assertion", message: assertion },
    ]),
    [
      "Failed tests:",
      "queue scene",
      "  Error: queue-condition-not-reached",
      "      at async file:///tmp/cloving-host-1/scenario.mjs:71:9",
      "queue assertion",
      "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
      "  1 !== 2",
      "      at TestContext.<anonymous> (file:///work/test/queue.test.ts:40:5)",
      "",
    ].join("\n"),
  );
});

await test("CLV-353 shows the actual and expected values of a failed assert.equal", async () => {
  const output = await failureOutput([
    {
      name: "numbers",
      message: assertionMessage(() => {
        assert.equal(1, 2);
      }),
    },
    {
      name: "texts",
      message: assertionMessage(() => {
        assert.equal("retention", "queue-condition-not-reached");
      }),
    },
  ]);
  assert.match(output, /^numbers\n {2}Expected values .*\n {2}1 !== 2$/m);
  assert.match(
    output,
    /^texts\n(?: {2}.+\n)*? {2}\+ 'retention'\n {2}- 'queue-condition-not-reached'$/m,
  );
});

await test("CLV-353 shows the last 10 lines of a message with no error, location or values", async () => {
  const message = `${Array.from(
    { length: 15 },
    (_, index) => `log ${String(index + 1)}`,
  ).join("\n")}\n\n`;
  assert.equal(
    await failureOutput([{ name: "plain", message }]),
    [
      "Failed tests:",
      "plain",
      ...Array.from({ length: 10 }, (_, index) => `  log ${String(index + 6)}`),
      "",
    ].join("\n"),
  );
});

await test("CLV-353 keeps the list limit with many long failures", async () => {
  const message = Array.from(
    { length: 30 },
    (_, index) => `Error: cause ${String(index)} ${"m".repeat(600)}`,
  ).join("\n");
  const output = await failureOutput(
    Array.from({ length: 50 }, (_, index) => ({
      name: `failure ${String(index)}`,
      message,
      file: "test/long.test.ts",
      line: 12,
      column: 34,
    })),
  );
  const lines = output.trimEnd().split("\n");
  assert.equal(lines.length, 200);
  assert.ok(lines.every((line) => line.length <= 500));
  assert.equal(lines.filter((line) => line.startsWith("  Error:")).length, 180);
  assert.equal(lines[198], "  at test/long.test.ts:12:34");
  assert.equal(lines[199], "41 failures not shown.");
});
