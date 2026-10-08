export interface DependencyQualification {
  readonly baseline: string;
  readonly candidate: string;
  readonly capability: string;
  readonly alternatives: string;
  readonly risks: string;
  readonly review: string;
  readonly checks: readonly string[];
  readonly scope: "within-grant" | "design-decision";
  readonly decision?: string;
}

export interface DependencyAdmission {
  readonly baseline: string;
  readonly qualifications: readonly DependencyQualification[];
}

export function admitDependencies(
  candidate: string,
  policy: DependencyAdmission,
): string {
  if (candidate === policy.baseline) return "unchanged";
  const qualification = policy.qualifications.find(
    (record) =>
      record.baseline === policy.baseline && record.candidate === candidate,
  );
  if (!qualification) throw new Error("unreviewed-dependency-surface");
  if (
    [
      qualification.capability,
      qualification.alternatives,
      qualification.risks,
      qualification.review,
    ].some((value) => value.trim().length === 0) ||
    qualification.checks.length === 0 ||
    qualification.checks.some((value) => value.trim().length === 0)
  )
    throw new Error("incomplete-dependency-qualification");
  if (
    qualification.scope === "design-decision" &&
    !qualification.decision?.trim()
  )
    throw new Error("dependency-design-decision");
  return "qualified";
}
