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
  const fallback = Math.max(1, ...Object.values(run.durations));
  const totals = Array.from({ length: shard.count }, (_, index) =>
    index === 0 ? fallback : 0,
  );
  const files = [
    ...ordered.filter((file) => Number.isFinite(seconds(file))),
    ...ordered.filter((file) => !Number.isFinite(seconds(file))),
  ];
  const shards = totals.map((): string[] => []);
  for (const [position, file] of files.entries()) {
    const reserved =
      files.length - position <=
      shards.filter((assigned) => assigned.length === 0).length;
    const weights = totals.map((total, index) =>
      reserved && (shards[index]?.length ?? 0) > 0 ? Infinity : total,
    );
    const index = weights.indexOf(Math.min(...weights));
    totals[index] =
      (totals[index] ?? 0) +
      (Number.isFinite(seconds(file)) ? seconds(file) : fallback);
    shards[index]?.push(file);
  }
  return shards[shard.index - 1] ?? [];
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
