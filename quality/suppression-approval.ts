import type ts from "typescript";
import { createHash } from "node:crypto";
import { inspectSuppressions } from "./suppressions.ts";
import type { SuppressionFinding } from "./suppressions.ts";

export interface SuppressionApproval {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly sourceDigest: string;
  readonly justification: string;
  readonly decision: string;
  readonly removalCondition: string;
}

export function checkSuppressions(
  sources: readonly ts.SourceFile[],
  approvals: readonly SuppressionApproval[],
): void {
  const findings = sources.flatMap(inspectSuppressions);
  const remaining = new Set(findings);
  for (const approval of approvals) {
    const finding = approvedFinding(sources, findings, approval);
    if (!remaining.delete(finding))
      throw new Error("duplicate-suppression-approval");
  }
  if (remaining.size > 0)
    throw new Error(
      `unapproved-suppression:\n${JSON.stringify([...remaining], null, 2)}`,
    );
}

function approvedFinding(
  sources: readonly ts.SourceFile[],
  findings: readonly SuppressionFinding[],
  approval: SuppressionApproval,
): SuppressionFinding {
  if (
    approval.rule !== "negative-type-test" ||
    [approval.justification, approval.decision, approval.removalCondition].some(
      (value) => value.trim().length === 0,
    )
  )
    throw new Error("invalid-suppression-approval");
  const source = sources.find((item) => item.fileName === approval.file);
  if (
    !source ||
    createHash("sha256").update(source.text).digest("hex") !==
      approval.sourceDigest
  )
    throw new Error("suppression-approval-source-mismatch");
  const finding = findings.find(
    (item) =>
      item.file === approval.file &&
      item.line === approval.line &&
      item.marker === "@ts-expect-error",
  );
  if (!finding) throw new Error("unused-suppression-approval");
  return finding;
}
