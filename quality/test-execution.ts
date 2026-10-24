import {
  runCommand,
  type CheckCommand,
  type CommandOptions,
} from "./command.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { availableParallelism, tmpdir } from "node:os";
import { checkCoverage } from "./coverage.ts";
import recordedDurations from "./test-durations.json" with { type: "json" };

export function testConcurrency(cores: number): number {
  return Math.min(4, Math.max(2, cores - 1));
}

export function parseTestConcurrency(
  value: string | undefined,
  cores: number,
): number {
  if (value === undefined) return testConcurrency(cores);
  if (!/^[1-8]$/.test(value))
    throw new Error(
      "CLOVING_TEST_CONCURRENCY must be a whole number from 1 to 8",
    );
  return Number(value);
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
  readonly commandOptions?: CommandOptions;
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
    readonly durations?: Readonly<Record<string, number>>;
    readonly reporter?: "durations";
  },
): CheckCommand {
  return {
    check: "tests",
    executable: process.execPath,
    arguments: [
      resolve(import.meta.dirname, "test-runner.ts"),
      `--test-reporter=${run.reporter ?? "gate"}`,
      `--test-concurrency=${String(parseTestConcurrency(process.env["CLOVING_TEST_CONCURRENCY"], availableParallelism()))}`,
      ...orderTests(directory, {
        tests: run.tests,
        durations: run.durations ?? recordedDurations,
      }),
    ],
    directory,
    timeoutMilliseconds: 600000 * (run.timeFactor ?? 1),
    processGroup: "isolated",
    ...(run.coverageDirectory === undefined
      ? {}
      : { coverageDirectory: run.coverageDirectory }),
  };
}

function orderTests(
  directory: string,
  run: {
    readonly tests: readonly string[];
    readonly durations: Readonly<Record<string, number>>;
  },
): string[] {
  const seconds = (file: string): number =>
    run.durations[relative(directory, resolve(directory, file))] ?? Infinity;
  return [...run.tests].sort().sort((left, right) => {
    const first = seconds(left);
    const second = seconds(right);
    return first === second ? 0 : second - first;
  });
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
    check: "coverage",
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
    options.commandOptions,
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
      options.commandOptions,
    ),
  );
  checkCoverage(coverage, options.coverageFiles);
}
