import { parseTestShard } from "./command.ts";
import { relative, resolve } from "node:path";

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
  const selected: string[] = [];
  for (const file of [
    ...ordered.filter((file) => Number.isFinite(seconds(file))),
    ...ordered.filter((file) => !Number.isFinite(seconds(file))),
  ]) {
    const index = totals.indexOf(Math.min(...totals));
    totals[index] =
      (totals[index] ?? 0) +
      (Number.isFinite(seconds(file)) ? seconds(file) : fallback);
    if (index === shard.index - 1) selected.push(file);
  }
  return selected;
}
