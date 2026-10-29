import assert from "node:assert/strict";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { reportTestFailures } from "../../quality/test-failures.ts";
import { failedOutput, retainedReport } from "./test-failure-fixture.ts";

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
