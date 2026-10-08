import { runCommand } from "./command.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkCoverage } from "./coverage.ts";

export interface TestExecutionOptions {
  readonly coverageFiles?: readonly string[];
  readonly requiredTests?: Readonly<Record<string, readonly string[]>>;
}

function validateReport(report: object, tests: readonly string[]): void {
  if (
    !("completed" in report) ||
    typeof report.completed !== "number" ||
    report.completed < 1 ||
    !("files" in report) ||
    JSON.stringify(report.files) !== JSON.stringify(tests)
  )
    throw new Error("No completed tests in the test report");
}

function validateOutcomes(report: object): void {
  for (const [field, rule] of [
    ["skipped", "skipped-mandatory-test"],
    ["failures", "test-report-failure"],
  ]) {
    if (!field || !rule) throw new Error("invalid-outcome-field");
    const value: unknown = Reflect.get(report, field);
    if (!Array.isArray(value) || value.length > 0) throw new Error(rule);
  }
}

function validateRequiredTests(
  report: object,
  required: Readonly<Record<string, readonly string[]>>,
): void {
  const expected = Object.entries(required)
    .flatMap(([file, names]) =>
      names.map((name) => JSON.stringify([realpathSync(file), name])),
    )
    .sort();
  if (
    expected.length === 0 ||
    !("identities" in report) ||
    JSON.stringify(report.identities) !== JSON.stringify(expected)
  )
    throw new Error("mandatory-test-inventory-mismatch");
}

export function checkTests(
  directory: string,
  files: readonly string[],
  options: TestExecutionOptions = {},
): void {
  const tests = files
    .filter((file) => /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file))
    .map((file) => realpathSync(file))
    .sort();
  if (tests.length === 0)
    throw new Error("Cannot accept an empty test inventory");
  const temporary = mkdtempSync(join(tmpdir(), "cloving-test-coverage-"));
  const checked = [
    ...new Set([...files, ...(options.coverageFiles ?? [])]),
  ].sort();
  const before = sourceSnapshot(checked);
  try {
    executeTests(directory, tests, temporary, options);
    if (before !== sourceSnapshot(checked))
      throw new Error("test-source-changed");
  } finally {
    rmSync(temporary, { recursive: true });
  }
}

function sourceSnapshot(files: readonly string[]): string {
  return JSON.stringify(
    files.map((file) => [
      file,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
}

function executeTests(
  directory: string,
  tests: readonly string[],
  temporary: string,
  options: TestExecutionOptions,
): void {
  const output = runCommand({
    executable: process.execPath,
    arguments: [
      "--test",
      `--test-reporter=${resolve(import.meta.dirname, "test-reporter.ts")}`,
      "--test-concurrency=2",
      ...tests,
    ],
    directory,
    timeoutMilliseconds: 120000,
    ...(options.coverageFiles ? { coverageDirectory: temporary } : {}),
  });
  const report: unknown = JSON.parse(output);
  if (!report || typeof report !== "object")
    throw new Error("Invalid test report");
  validateReport(report, tests);
  validateOutcomes(report);
  if (options.requiredTests)
    validateRequiredTests(report, options.requiredTests);
  if (!options.coverageFiles) return;
  const coverage: unknown = JSON.parse(
    runCommand({
      executable: process.execPath,
      arguments: [
        resolve(import.meta.dirname, "coverage-command.ts"),
        temporary,
        ...options.coverageFiles,
      ],
      directory,
      timeoutMilliseconds: 60000,
    }),
  );
  checkCoverage(coverage, options.coverageFiles);
}
