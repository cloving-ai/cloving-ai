import type { TestFailure } from "./test-reporter.ts";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function isFailure(value: unknown): value is TestFailure {
  if (!value || typeof value !== "object") return false;
  const fields: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(value),
  );
  return (
    typeof fields["name"] === "string" &&
    typeof fields["message"] === "string" &&
    (fields["file"] === undefined || typeof fields["file"] === "string") &&
    ["line", "column"].every(
      (field) =>
        fields[field] === undefined || typeof fields[field] === "number",
    ) &&
    Array.isArray(fields["stderr"]) &&
    fields["stderr"].every((line: unknown) => typeof line === "string")
  );
}

function failureLines(failure: TestFailure): string[] {
  const lines = [failure.name, `  ${failure.message}`];
  if (failure.file !== undefined) {
    const location = [failure.file, failure.line, failure.column]
      .filter((value) => value !== undefined)
      .join(":");
    lines.push(`  at ${location}`);
  }
  if (failure.stderr.length > 0)
    lines.push("  stderr:", ...failure.stderr.map((line) => `  ${line}`));
  return lines.map((line) => (line.split(/[\r\n]/, 1)[0] ?? "").slice(0, 500));
}

function failureList(failures: readonly TestFailure[]): string {
  const lines = ["Failed tests:"];
  let shown = 0;
  for (const failure of failures) {
    const block = failureLines(failure);
    const limit = shown === failures.length - 1 ? 200 : 199;
    if (lines.length + block.length > limit) break;
    lines.push(...block);
    shown += 1;
  }
  if (shown < failures.length)
    lines.push(`${String(failures.length - shown)} failures not shown.`);
  return lines.join("\n") + "\n";
}

export function reportTestFailures(report: object, output: string): void {
  if (!("failures" in report) || !Array.isArray(report.failures)) return;
  const failures: readonly unknown[] = report.failures;
  if (failures.length === 0) return;
  if (!failures.every(isFailure))
    throw new Error("Invalid test failure report");
  process.stderr.write(failureList(failures));
  const path = join(tmpdir(), `cloving-test-report-${randomUUID()}.json`);
  writeFileSync(path, output, { mode: 0o600, flag: "wx" });
  throw new Error(`test-report-failure. Full test report: ${path}`);
}
