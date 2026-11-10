import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseTestShard, type TestSet } from "./command.ts";

export function selectTestShard(
  directory: string,
  run: {
    readonly tests: readonly string[];
    readonly durations: Readonly<Record<string, number>>;
    readonly shard?: string;
  },
): string[] {
  const seconds = (file: string): number =>
    run.durations[relative(directory, resolve(directory, file))] ?? Infinity;
  const ordered = [...run.tests].sort().sort((left, right) => {
    const first = seconds(left);
    const second = seconds(right);
    return first === second ? 0 : second - first;
  });
  const shard = parseTestShard(run.shard);
  if (!shard) return ordered;
  if (shard.count > ordered.length) throw new Error("empty test shard");
  const totals = Array.from({ length: shard.count }, () => 0);
  const fallback = Math.max(1, ...Object.values(run.durations));
  const selected: string[] = [];
  for (const file of ordered) {
    const index = totals.indexOf(Math.min(...totals));
    totals[index] =
      (totals[index] ?? 0) +
      (Number.isFinite(seconds(file)) ? seconds(file) : fallback);
    if (index === shard.index - 1) selected.push(file);
  }
  return selected;
}

function pathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

export function selectTestSet(
  directory: string,
  run: {
    readonly tests: readonly string[];
    readonly set: TestSet | undefined;
  },
): readonly string[] {
  if (run.set !== "platform") return run.tests;
  const list = "quality/platform-tests.json";
  const listed: unknown = JSON.parse(
    readFileSync(join(directory, list), "utf8"),
  );
  if (!pathList(listed))
    throw new Error(`${list} must be a JSON array of paths`);
  if (JSON.stringify([...new Set(listed)].sort()) !== JSON.stringify(listed))
    throw new Error(`${list} must be sorted with no duplicates`);
  const root = realpathSync(directory);
  const missing = listed.find(
    (file) => !run.tests.includes(resolve(root, file)),
  );
  if (missing !== undefined)
    throw new Error(
      `${list} names a file that is not in the test inventory: ${missing}`,
    );
  return listed.map((file) => resolve(root, file));
}

export interface LeftOutTest {
  readonly file: string;
  readonly reason: string;
}

interface MainOnlyGroup {
  readonly files: readonly string[];
  readonly triggers: readonly string[];
}

const mainOnlyList = "quality/main-only-tests.json";

function mainOnlyGroups(value: unknown): value is MainOnlyGroup[] {
  return (
    Array.isArray(value) &&
    value.every(
      (group: unknown) =>
        typeof group === "object" &&
        group !== null &&
        pathList(Reflect.get(group, "files")) &&
        pathList(Reflect.get(group, "triggers")),
    )
  );
}

function sortedNames(names: readonly string[]): boolean {
  return JSON.stringify([...new Set(names)].sort()) === JSON.stringify(names);
}

function mainOnlyFailure(message: string): never {
  throw new Error(`${mainOnlyList} ${message}`);
}

function checkMainOnlyGroup(
  group: MainOnlyGroup,
  context: {
    readonly inventory: readonly string[];
    readonly named: Set<string>;
  },
): void {
  const { files, triggers } = group;
  if (
    [files, triggers].some((names) => names.length === 0 || names.includes(""))
  )
    mainOnlyFailure("must give each group files and triggers");
  if (!sortedNames(files) || !sortedNames(triggers))
    mainOnlyFailure("must keep files and triggers sorted with no duplicates");
  for (const file of files) {
    if (context.named.has(file))
      mainOnlyFailure(`names a file two times: ${file}`);
    context.named.add(file);
    if (!context.inventory.includes(file))
      mainOnlyFailure(
        `names a file that is not in the test inventory: ${file}`,
      );
    if (!triggers.some((trigger) => file.startsWith(trigger)))
      mainOnlyFailure(
        `names a file that its own triggers do not match: ${file}`,
      );
  }
}

function readMainOnlyGroups(
  directory: string,
  inventory: readonly string[],
): readonly MainOnlyGroup[] {
  const groups: unknown = JSON.parse(
    readFileSync(join(directory, mainOnlyList), "utf8"),
  );
  if (!mainOnlyGroups(groups))
    mainOnlyFailure("must be a JSON array of groups with files and triggers");
  const named = new Set<string>();
  for (const group of groups) checkMainOnlyGroup(group, { inventory, named });
  return groups;
}

export function selectChangedTests(
  directory: string,
  run: {
    readonly inventory: readonly string[];
    readonly tests: readonly string[];
    readonly changedPaths: readonly string[] | undefined;
  },
): { readonly tests: readonly string[]; readonly leftOut: LeftOutTest[] } {
  if (run.changedPaths === undefined) return { tests: run.tests, leftOut: [] };
  const changed = run.changedPaths;
  const root = realpathSync(directory);
  const inventory = run.inventory.map((file) => relative(root, file));
  const leftOut: LeftOutTest[] = [];
  for (const { files, triggers } of readMainOnlyGroups(root, inventory)) {
    if (
      changed.some((path) =>
        triggers.some((trigger) => path.startsWith(trigger)),
      )
    )
      continue;
    for (const file of files.filter((name) =>
      run.tests.includes(resolve(root, name)),
    ))
      leftOut.push({
        file,
        reason: `no changed path matches its triggers: ${triggers.join(", ")}`,
      });
  }
  leftOut.sort((first, second) => (first.file < second.file ? -1 : 1));
  return {
    tests: run.tests.filter(
      (file) => !leftOut.some((entry) => resolve(root, entry.file) === file),
    ),
    leftOut,
  };
}
