import { resolve } from "node:path";
import { inspect } from "node:util";
import type { TestEvent } from "node:test/reporters";
import type { CoverageRow } from "./coverage.ts";

const stderrLines = 20;
const stderrLineCharacters = 500;
const failureCharacters = 100_000;
const boundedDepth = 8;
const boundedItems = 100;
const boundedCharacters = 10_000;

const errorKeys = new Set(["cause", "message", "stack", "name"]);

interface Bounds {
  readonly ancestors: readonly object[];
}

function boundedText(text: string): string {
  if (text.length <= boundedCharacters) return text;
  return `${text.slice(0, boundedCharacters)}... ${String(text.length - boundedCharacters)} more characters`;
}

function boundedStack(error: Error): string {
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, boundedItems);
  return [`${error.name}: ${boundedText(error.message)}`, ...frames].join("\n");
}

function boundedEntries(
  value: object,
  bounds: Bounds,
): Array<readonly [string, unknown]> {
  const keys = Object.keys(value).filter(
    (key) => !(value instanceof Error && errorKeys.has(key)),
  );
  const entries = keys
    .slice(0, boundedItems)
    .map((key) => [key, bounded(Reflect.get(value, key), bounds)] as const);
  if (keys.length <= boundedItems) return entries;
  return [...entries, ["...", `${String(keys.length - boundedItems)} more`]];
}

function boundedError(error: Error, bounds: Bounds): Error {
  const copy = new Error(boundedText(error.message), {
    cause: bounded(error.cause, bounds),
  });
  if (error.cause === undefined) delete copy.cause;
  copy.name = error.name;
  copy.stack = boundedStack(error);
  for (const [key, value] of boundedEntries(error, bounds))
    Reflect.set(copy, key, value);
  return copy;
}

function firstItems<T>(items: Iterable<T>): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (result.length >= boundedItems) break;
    result.push(item);
  }
  return result;
}

function rest(size: number): string {
  return `${String(size - boundedItems)} more`;
}

function keptValue(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value)
  );
}

function boundedMap(value: Map<unknown, unknown>, bounds: Bounds): unknown {
  const entries = firstItems(value).map(
    ([key, item]) => [bounded(key, bounds), bounded(item, bounds)] as const,
  );
  if (value.size <= boundedItems) return new Map(entries);
  return new Map([...entries, ["...", rest(value.size)] as const]);
}

function boundedList(items: Iterable<unknown>, bounds: Bounds): unknown[] {
  return firstItems(items).map((item) => bounded(item, bounds));
}

function boundedObject(value: object, bounds: Bounds): unknown {
  if (value instanceof Map) return boundedMap(value, bounds);
  if (value instanceof Set) {
    const items = boundedList(value, bounds);
    if (value.size <= boundedItems) return new Set(items);
    return new Set([...items, `... ${rest(value.size)} items`]);
  }
  if (!Array.isArray(value))
    return Object.fromEntries(boundedEntries(value, bounds));
  const items = boundedList(value, bounds);
  if (value.length <= boundedItems) return items;
  return [...items, `... ${rest(value.length)} items`];
}

function bounded(value: unknown, bounds: Bounds): unknown {
  if (typeof value === "string") return boundedText(value);
  if (typeof value !== "object" || value === null) return value;
  if (bounds.ancestors.includes(value)) return "[Circular]";
  if (bounds.ancestors.length >= boundedDepth) return "[Object]";
  if (keptValue(value)) return value;
  const next = { ancestors: [...bounds.ancestors, value] };
  if (value instanceof Error) return boundedError(value, next);
  return boundedObject(value, next);
}

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
    error: inspect(bounded(details.error, { ancestors: [] }), {
      depth: null,
      maxArrayLength: boundedItems + 1,
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
