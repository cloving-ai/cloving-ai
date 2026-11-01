import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectCoverage } from "../../quality/coverage-report.ts";
import { checkCoverage } from "../../quality/coverage.ts";
import * as shardCoverage from "../../quality/shard-coverage.ts";
import { runSupervisedCommand } from "../../quality/command.ts";
import { checkTests, testCommand } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

const files = {
  "package.json": '{"type":"module"}',
  "main.ts":
    'export function choose(value: number): string { if (value > 0) return "positive"; return "other"; }',
  "a.test.ts":
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { choose } from "./main.ts"; await test("positive", () => { assert.equal(choose(1), "positive"); });',
  "b.test.ts":
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { choose } from "./main.ts"; await test("other", () => { assert.equal(choose(0), "other"); });',
};

await test("CLV-266 each shard exports portable raw coverage without checking partial coverage", async () => {
  await withFiles(files, async (directory) => {
    const production = join(directory, "main.ts");
    const tests = ["a.test.ts", "b.test.ts"].map((file) =>
      join(directory, file),
    );
    const coverageDirectory = join(directory, "shard-coverage");
    await checkTests(directory, {
      files: [production, ...tests],
      coverageFiles: [production],
      shard: "1/2",
      coverageDirectory,
      requiredTests: {
        [tests[0] ?? ""]: ["positive"],
        [tests[1] ?? ""]: ["other"],
      },
    });
    assert.equal(existsSync(coverageDirectory), true);
    const recordings = readdirSync(coverageDirectory);
    assert.ok(recordings.length > 0);
    const raw = recordings
      .map((file) => readFileSync(join(coverageDirectory, file), "utf8"))
      .join("");
    assert.doesNotMatch(raw, new RegExp(directory));
    assert.match(raw, /cloving:\/\/\/main.ts/);
  });
});

await test("CLV-266 joined coverage from separate checkouts equals a complete run", async () => {
  assert.equal(typeof shardCoverage.joinShardCoverage, "function");
  await withFiles(files, async (directory) => {
    const production = join(directory, "main.ts");
    const complete = join(directory, "complete");
    mkdirSync(complete);
    await runSupervisedCommand(
      testCommand(directory, {
        tests: ["a.test.ts", "b.test.ts"].map((file) => join(directory, file)),
        coverageDirectory: complete,
      }),
    );
    const expected = await collectCoverage(complete, [production]);
    await withFiles(files, async (other) => {
      const directories: string[] = [];
      for (const [index, root] of [directory, other].entries()) {
        const output = join(root, "exported");
        await checkTests(root, {
          files: ["a.test.ts", "b.test.ts"].map((file) => join(root, file)),
          coverageFiles: [join(root, "main.ts")],
          shard: `${String(index + 1)}/2`,
          coverageDirectory: output,
        });
        directories.push(output);
      }
      const joined = await shardCoverage.joinShardCoverage(directory, {
        directories,
        files: [production],
      });
      assert.deepEqual(joined, expected);
      checkCoverage(joined, [production]);
      const partial = await shardCoverage.joinShardCoverage(directory, {
        directories: directories.slice(0, 1),
        files: [production],
      });
      assert.throws(() => {
        checkCoverage(partial, [production]);
      }, /insufficient-production-coverage/);
    });
  });
});
