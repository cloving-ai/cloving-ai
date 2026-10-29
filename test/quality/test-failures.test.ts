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
      message: `${"m".repeat(600)}\nextra message`,
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
  assert.doesNotMatch(result.output, /extra (?:name|message|file)/);
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
