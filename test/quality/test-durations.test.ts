import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runCommand } from "../../quality/command.ts";
import { testCommand } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

await test("CLV-174 starts unknown files first, then longest files with path ties", () => {
  const tests = ["fast", "new-b", "slow-b", "new-a", "slow-a"]
    .map((name) => resolve("test", `${name}.test.ts`))
    .sort();
  const durations = {
    "test/fast.test.ts": 0,
    "test/slow-b.test.ts": 10,
    "test/slow-a.test.ts": 10,
    "test/deleted.test.ts": 100,
  };
  const expected = ["new-a", "new-b", "slow-a", "slow-b", "fast"].map((name) =>
    resolve("test", `${name}.test.ts`),
  );
  const original = [...tests];
  for (const files of [tests, [...tests].reverse(), tests])
    assert.deepEqual(
      testCommand(process.cwd(), { tests: files, durations }).arguments.slice(
        -tests.length,
      ),
      expected,
    );
  assert.deepEqual(tests, original);
});

await test("CLV-174 keeps report files sorted when slow files start first", async () => {
  const source =
    'import { test } from "node:test"; await test("passes", () => {});';
  await withFiles({ "a.test.ts": source, "z.test.ts": source }, (directory) => {
    const tests = [join(directory, "a.test.ts"), join(directory, "z.test.ts")];
    const command = testCommand(directory, {
      tests,
      durations: { "a.test.ts": 1, "z.test.ts": 20 },
    });
    assert.deepEqual(command.arguments.slice(-2), [...tests].reverse());
    const report: unknown = JSON.parse(runCommand(command));
    assert.ok(report !== null && typeof report === "object");
    assert.deepEqual(Reflect.get(report, "files"), tests);
    assert.equal(Reflect.get(report, "completed"), 2);
    assert.deepEqual(Reflect.get(report, "failures"), []);
  });
});

await test("CLV-174 actually starts the slow file first with one worker", async () => {
  const source =
    'import { appendFileSync } from "node:fs"; import { basename } from "node:path"; import { test } from "node:test"; appendFileSync("starts", basename(import.meta.filename) + "\\n"); await test("passes", () => {});';
  await withFiles({ "a.test.ts": source, "z.test.ts": source }, (directory) => {
    const command = testCommand(directory, {
      tests: [join(directory, "a.test.ts"), join(directory, "z.test.ts")],
      durations: { "a.test.ts": 1, "z.test.ts": 20 },
    });
    runCommand({
      ...command,
      arguments: command.arguments.map((argument) =>
        argument.startsWith("--test-concurrency=")
          ? "--test-concurrency=1"
          : argument,
      ),
    });
    assert.equal(
      readFileSync(join(directory, "starts"), "utf8"),
      "z.test.ts\na.test.ts\n",
    );
  });
});
