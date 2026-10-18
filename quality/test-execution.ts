import { runCommand, type CheckCommand } from "./command.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { availableParallelism, tmpdir } from "node:os";
import { checkCoverage } from "./coverage.ts";

export function testConcurrency(cores: number): number {
  return Math.min(4, Math.max(2, cores - 1));
}

export function parseCheckTimeFactor(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[1-5]$/.test(value))
    throw new Error(
      "CLOVING_CHECK_TIME_FACTOR must be a whole number from 1 to 5",
    );
  return Number(value);
}

export interface TestExecutionOptions {
  readonly timeFactor?: number;
  readonly coverageFiles?: readonly string[];
  readonly requiredTests?: Readonly<Record<string, readonly string[]>>;
}

export interface TestExecution extends TestExecutionOptions {
  readonly files: readonly string[];
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

export function checkTests(directory: string, execution: TestExecution): void {
  const { files, ...options } = execution;
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
    executeTests(directory, { tests, temporary, options });
    if (before !== sourceSnapshot(checked))
      throw new Error("test-source-changed");
  } finally {
    rmSync(temporary, { recursive: true, maxRetries: 3, retryDelay: 100 });
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

export function testCommand(
  directory: string,
  run: {
    readonly tests: readonly string[];
    readonly coverageDirectory?: string;
    readonly timeFactor?: number;
  },
): CheckCommand {
  return {
    executable: process.execPath,
    arguments: [
      "--test",
      `--test-reporter=${resolve(import.meta.dirname, "test-reporter.ts")}`,
      `--test-concurrency=${String(testConcurrency(availableParallelism()))}`,
      ...run.tests,
    ],
    directory,
    timeoutMilliseconds: 600000 * (run.timeFactor ?? 1),
    ...(run.coverageDirectory === undefined
      ? {}
      : { coverageDirectory: run.coverageDirectory }),
  };
}

export function coverageCommand(
  directory: string,
  run: {
    readonly coverageDirectory: string;
    readonly files: readonly string[];
    readonly timeFactor?: number;
  },
): CheckCommand {
  return {
    executable: process.execPath,
    arguments: [
      resolve(import.meta.dirname, "coverage-command.ts"),
      run.coverageDirectory,
      ...run.files,
    ],
    directory,
    timeoutMilliseconds: 60000 * (run.timeFactor ?? 1),
  };
}

function executeTests(
  directory: string,
  run: {
    readonly tests: readonly string[];
    readonly temporary: string;
    readonly options: TestExecutionOptions;
  },
): void {
  const { tests, temporary, options } = run;
  const output = runCommand(
    testCommand(directory, {
      tests,
      timeFactor: options.timeFactor ?? 1,
      ...(options.coverageFiles ? { coverageDirectory: temporary } : {}),
    }),
  );
  const report: unknown = JSON.parse(output);
  if (!report || typeof report !== "object")
    throw new Error("Invalid test report");
  validateReport(report, tests);
  validateOutcomes(report);
  if (options.requiredTests)
    validateRequiredTests(report, options.requiredTests);
  if (!options.coverageFiles) return;
  const coverage: unknown = JSON.parse(
    runCommand(
      coverageCommand(directory, {
        coverageDirectory: temporary,
        files: options.coverageFiles,
        timeFactor: options.timeFactor ?? 1,
      }),
    ),
  );
  checkCoverage(coverage, options.coverageFiles);
}
