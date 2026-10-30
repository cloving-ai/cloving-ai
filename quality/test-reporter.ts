import { resolve } from "node:path";
import { inspect } from "node:util";
import type { TestEvent } from "node:test/reporters";
import type { CoverageRow } from "./coverage.ts";

const stderrLines = 20;
const stderrLineCharacters = 500;
const failureCharacters = 100_000;

export interface TestFailure {
  readonly name: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly message: string;
  readonly error?: string;
  readonly stderr: readonly string[];
}

function withStderr(
  stderr: Map<string, readonly string[]>,
  event: { readonly file?: string | undefined; readonly message: string },
): void {
  if (event.file === undefined) return;
  const file = resolve(event.file);
  const lines = event.message
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(0, stderrLineCharacters));
  stderr.set(file, [...(stderr.get(file) ?? []), ...lines].slice(-stderrLines));
}

function fileStderr(
  stderr: ReadonlyMap<string, readonly string[]>,
  failure: { readonly name: string; readonly file?: string | undefined },
): readonly string[] {
  if (failure.file === undefined) return [];
  if (resolve(failure.name) !== resolve(failure.file)) return [];
  return stderr.get(resolve(failure.file)) ?? [];
}

function failureOutput(
  event: TestEvent,
  output: {
    readonly stderr: Map<string, readonly string[]>;
    readonly failures: TestFailure[];
  },
): boolean {
  if (event.type === "test:stderr") {
    withStderr(output.stderr, event.data);
    return true;
  }
  if (event.type !== "test:fail") return false;
  const { name, file, line, column, details } = event.data;
  output.failures.push({
    name,
    file,
    line,
    column,
    message: details.error.message.slice(0, failureCharacters),
    error: inspect(details.error, {
      depth: 8,
      maxArrayLength: 100,
      maxStringLength: 10_000,
      colors: false,
      customInspect: false,
    }).slice(0, failureCharacters),
    stderr: fileStderr(output.stderr, event.data),
  });
  return true;
}

export default async function* reportTests(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  let completed = 0;
  const files = new Set<string>();
  const failures: TestFailure[] = [];
  const skipped: string[] = [];
  const coverage: Array<Omit<CoverageRow, "statements">> = [];
  const identities: string[] = [];
  const stderr = new Map<string, readonly string[]>();
  for await (const event of source) {
    if (failureOutput(event, { stderr, failures })) continue;
    if (event.type === "test:coverage") {
      coverage.push(
        ...event.data.summary.files.map((file) => ({
          path: file.path,
          lines: file.coveredLinePercent,
          functions: file.coveredFunctionPercent,
          branches: file.coveredBranchPercent,
        })),
      );
      continue;
    }
    if (event.type !== "test:pass") continue;
    const result = event.data;
    if (result.skip || result.todo) {
      skipped.push(result.name);
      continue;
    }
    if (result.details.type !== "test") continue;
    if (!result.file || resolve(result.name) === resolve(result.file)) continue;
    completed += 1;
    files.add(resolve(result.file));
    identities.push(JSON.stringify([resolve(result.file), result.name]));
  }
  yield JSON.stringify({
    completed,
    files: [...files].sort(),
    failures,
    skipped,
    coverage,
    identities: identities.sort(),
  });
}
