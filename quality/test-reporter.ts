import { resolve } from "node:path";
import { inspect } from "node:util";
import type { TestEvent } from "node:test/reporters";
import type { CoverageRow } from "./coverage.ts";

export default async function* reportTests(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  let completed = 0;
  const files = new Set<string>();
  const failures: string[] = [];
  const skipped: string[] = [];
  const coverage: Array<Omit<CoverageRow, "statements">> = [];
  const identities: string[] = [];
  for await (const event of source) {
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
    if (event.type === "test:fail") {
      failures.push(`${event.data.name}: ${inspect(event.data.details.error)}`);
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
