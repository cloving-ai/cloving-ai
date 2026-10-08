import { runCommand } from "./command.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function checkTests(directory: string, files: readonly string[]): void {
  const tests = files
    .filter((file) => /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file))
    .map((file) => realpathSync(file))
    .sort();
  if (tests.length === 0)
    throw new Error("Cannot accept an empty test inventory");
  const output = runCommand({
    executable: process.execPath,
    arguments: [
      "--test",
      `--test-reporter=${resolve(import.meta.dirname, "test-reporter.ts")}`,
      "--test-concurrency=2",
      ...tests,
    ],
    directory,
    timeoutMilliseconds: 60000,
  });
  const report: unknown = JSON.parse(output);
  if (
    !report ||
    typeof report !== "object" ||
    !("completed" in report) ||
    typeof report.completed !== "number" ||
    report.completed < 1 ||
    !("files" in report) ||
    JSON.stringify(report.files) !== JSON.stringify(tests)
  )
    throw new Error("No completed tests in the test report");
}
