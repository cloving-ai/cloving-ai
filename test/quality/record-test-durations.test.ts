import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runCommand } from "../../quality/command.ts";
import { withFiles } from "./files-fixture.ts";

function record(directory: string): void {
  runCommand({
    executable: process.execPath,
    arguments: [resolve("tools/record-test-durations.ts")],
    directory,
    timeoutMilliseconds: 10000,
  });
}

await test("CLV-174 the record command writes seconds for every test file in path order", async () => {
  await withFiles(
    {
      "quality/test-durations.json": '{"stale.test.ts":999}',
      "test/z.test.ts":
        'import { test } from "node:test"; await test("first", () => {}); await test("second", async (context) => { await context.test("nested", () => {}); });',
      "test/nested/a.test.ts":
        'import { describe, it } from "node:test"; describe("suite", () => { it("nested", () => {}); });',
      "test/helper.ts": 'throw new Error("helpers must not run");',
    },
    (directory) => {
      record(directory);
      const text = readFileSync(
        join(directory, "quality/test-durations.json"),
        "utf8",
      );
      const durations: unknown = JSON.parse(text);
      assert.ok(durations !== null && typeof durations === "object");
      assert.deepEqual(Object.keys(durations), [
        "test/nested/a.test.ts",
        "test/z.test.ts",
      ]);
      for (const seconds of Object.values(durations)) {
        assert.equal(typeof seconds, "number");
        assert.ok(Number.isFinite(seconds));
        assert.ok(seconds >= 0);
      }
      assert.equal(text, JSON.stringify(durations, null, 2) + "\n");
    },
  );
});

await test("CLV-174 a failed recording run preserves the previous duration record", async () => {
  const previous = '{"test/prior.test.ts":12}\n';
  await withFiles(
    {
      "quality/test-durations.json": previous,
      "test/failure.test.ts":
        'import { test } from "node:test"; await test("fails", () => { throw new Error("recording fixture"); });',
    },
    (directory) => {
      assert.throws(() => {
        record(directory);
      }, /Check exit 1/);
      assert.equal(
        readFileSync(join(directory, "quality/test-durations.json"), "utf8"),
        previous,
      );
    },
  );
});

await test("CLV-174 refuses a failed TODO even when Node exits successfully", async () => {
  await withFiles(
    {
      "quality/test-durations.json": "{}",
      "test/main.test.ts":
        'import { test } from "node:test"; await test("passes", () => {}); await test("unfinished", { todo: true }, () => { throw new Error("unfinished fixture"); });',
    },
    (directory) => {
      assert.throws(() => {
        record(directory);
      }, /incomplete-test-duration-run/);
      assert.equal(
        readFileSync(join(directory, "quality/test-durations.json"), "utf8"),
        "{}",
      );
    },
  );
});
