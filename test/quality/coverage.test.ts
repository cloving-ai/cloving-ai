import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkCoverage } from "../../quality/coverage.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-18 enforces all four coverage boundaries and rejects absent metrics", async () => {
  await withFiles({ "main.ts": "export {};" }, (directory) => {
    const path = join(directory, "main.ts");
    const boundary = {
      path,
      lines: 90,
      statements: 90,
      functions: 90,
      branches: 85,
    };
    assert.doesNotThrow(() => {
      checkCoverage([boundary], [path]);
    });
    for (const metric of [
      "lines",
      "statements",
      "functions",
      "branches",
    ] as const) {
      assert.throws(() => {
        checkCoverage(
          [{ ...boundary, [metric]: boundary[metric] - 0.01 }],
          [path],
        );
      }, /insufficient-production-coverage/);
      assert.throws(() => {
        checkCoverage([{ ...boundary, [metric]: undefined }], [path]);
      }, /invalid-coverage-report/);
    }
    assert.throws(() => {
      checkCoverage([boundary, boundary], [path]);
    }, /duplicate-coverage-source/);
  });
});

await test("QG-18 rejects an empty requested production coverage inventory", () => {
  assert.throws(() => {
    checkCoverage([], []);
  }, /empty-production-coverage/);
});
