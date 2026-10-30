import { resolve } from "node:path";
import { inspect } from "node:util";
import type { TestEvent } from "node:test/reporters";
import type { CoverageRow } from "./coverage.ts";

const stderrLines = 20;
const stderrLineCharacters = 500;
const failureCharacters = 100_000;
const boundedDepth = 8;
const boundedObjects = 2_000;
const boundedItems = 100;
const boundedCharacters = 10_000;

const errorKeys = new Set(["cause", "message", "stack", "name"]);

interface Bounds {
  readonly ancestors: readonly object[];
  readonly seen: WeakSet<object>;
  readonly budget: { remaining: number };
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

function typedArray(
  value: ArrayBufferView,
): value is ArrayBufferView & ArrayLike<unknown> & Iterable<unknown> {
  return "length" in value && Symbol.iterator in value;
}

function viewBytes(value: DataView): string {
  const count = Math.min(value.byteLength, boundedItems);
  const bytes = Array.from({ length: count }, (_, index) =>
    String(value.getUint8(index)),
  );
  const more =
    value.byteLength > boundedItems
      ? [`... ${rest(value.byteLength)} bytes`]
      : [];
  return `DataView(${String(value.byteLength)}) [ ${[...bytes, ...more].join(", ")} ]`;
}

function boundedView(value: ArrayBufferView): string {
  if (value instanceof DataView) return viewBytes(value);
  if (!typedArray(value)) return Object.prototype.toString.call(value);
  const items = firstItems(value).map(String);
  const { length } = value;
  const more = length > boundedItems ? [`... ${rest(length)} items`] : [];
  return `${value.constructor.name}(${String(length)}) [ ${[...items, ...more].join(", ")} ]`;
}

function builtInCopy(value: object): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (ArrayBuffer.isView(value)) return boundedView(value);
  if (!(value instanceof RegExp)) return undefined;
  if (value.source.length > boundedCharacters)
    return boundedText(String(value));
  return new RegExp(value.source, value.flags);
}

function boundedMap(value: Map<unknown, unknown>, bounds: Bounds): unknown {
  const entries = firstItems(value).map(
    ([key, item]) => [bounded(key, bounds), bounded(item, bounds)] as const,
  );
  const map = new Map(entries);
  if (value.size <= boundedItems && map.size === entries.length) return map;
  return { Map: value.size, entries, omitted: value.size - entries.length };
}

function boundedSet(value: Set<unknown>, bounds: Bounds): unknown {
  const values = firstItems(value).map((item) => bounded(item, bounds));
  const set = new Set(values);
  if (value.size <= boundedItems && set.size === values.length) return set;
  return { Set: value.size, values, omitted: value.size - values.length };
}

function boundedArray(value: readonly unknown[], bounds: Bounds): unknown[] {
  const items = value
    .slice(0, boundedItems)
    .map((item: unknown) => bounded(item, bounds));
  if (value.length <= boundedItems) return items;
  return items.concat([`... ${rest(value.length)} items`]);
}

function boundedObject(value: object, bounds: Bounds): unknown {
  if (value instanceof Map) return boundedMap(value, bounds);
  if (value instanceof Set) return boundedSet(value, bounds);
  if (Array.isArray(value)) return boundedArray(value, bounds);
  return Object.fromEntries(boundedEntries(value, bounds));
}

function copied(value: object, bounds: Bounds): unknown {
  const builtIn = builtInCopy(value);
  if (builtIn !== undefined) return builtIn;
  if (value instanceof Error) return boundedError(value, bounds);
  return boundedObject(value, bounds);
}

function bounded(value: unknown, bounds: Bounds): unknown {
  if (typeof value === "string") return boundedText(value);
  if (typeof value !== "object" || value === null) return value;
  if (bounds.ancestors.includes(value)) return "[Circular]";
  if (bounds.seen.has(value)) return "[Shared]";
  if (bounds.ancestors.length >= boundedDepth) return "[Object]";
  if (bounds.budget.remaining <= 0) return "[Object]";
  bounds.budget.remaining -= 1;
  bounds.seen.add(value);
  return copied(value, { ...bounds, ancestors: [...bounds.ancestors, value] });
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
    error: inspect(
      bounded(details.error, {
        ancestors: [],
        seen: new WeakSet(),
        budget: { remaining: boundedObjects },
      }),
      {
        depth: null,
        maxArrayLength: boundedItems + 1,
        colors: false,
        customInspect: false,
      },
    ).slice(0, failureCharacters),
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
