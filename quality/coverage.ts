import { realpathSync } from "node:fs";

export interface CoverageRow {
  readonly path: string;
  readonly lines: number;
  readonly statements: number;
  readonly functions: number;
  readonly branches: number;
}

function isCoverageRow(value: unknown): value is CoverageRow {
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string"
  )
    return false;
  return ["lines", "statements", "functions", "branches"].every((name) => {
    const metric: unknown = Reflect.get(value, name);
    return (
      typeof metric === "number" &&
      Number.isFinite(metric) &&
      metric >= 0 &&
      metric <= 100
    );
  });
}

export function checkCoverage(
  report: unknown,
  expected: readonly string[],
): void {
  if (expected.length === 0) throw new Error("empty-production-coverage");
  if (!Array.isArray(report) || !report.every(isCoverageRow))
    throw new Error("invalid-coverage-report");
  const paths = report.map((row) => realpathSync(row.path));
  if (new Set(paths).size !== paths.length)
    throw new Error("duplicate-coverage-source");
  for (const file of expected) {
    const record = report.find(
      (row: CoverageRow) => realpathSync(row.path) === realpathSync(file),
    );
    if (!record) throw new Error(`missing-production-coverage: ${file}`);
    if (
      [record.lines, record.statements, record.functions].some(
        (metric) => metric < 90,
      ) ||
      record.branches < 85
    )
      throw new Error(`insufficient-production-coverage: ${file}`);
  }
}
