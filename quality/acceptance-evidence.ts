import type { AcceptancePlan } from "./acceptance-plan.ts";
import type { executeInstalledCheck } from "./installed-check.ts";
import type { VerifierActivation } from "./verifier-activation.ts";
import { join } from "node:path";

export type StaticEvidence = Awaited<ReturnType<typeof executeInstalledCheck>>;

export function checkStaticEvidence(
  checked: StaticEvidence,
  activation: VerifierActivation,
  trusted: { readonly candidate: string; readonly executable: string },
): void {
  checkStaticCommand(checked, activation, trusted);
  const { execution } = checked;
  if (
    execution.exit !== 0 ||
    execution.signal !== null ||
    execution.error !== null
  )
    throw new Error("static-check-failed");
  const report = parseReport(execution.stdout);
  if (
    report?.["kind"] !== "static-analysis" ||
    JSON.stringify(report["completed"]) !==
      JSON.stringify(activation.plan.staticChecks)
  )
    throw new Error("missing-required-static-check");
}

function checkStaticCommand(
  checked: StaticEvidence,
  activation: VerifierActivation,
  trusted: { readonly candidate: string; readonly executable: string },
): void {
  const { directory, identity } = activation.verifier;
  if (
    checked.verifier !== identity ||
    checked.command.executable !== trusted.executable ||
    checked.command.directory !== directory ||
    JSON.stringify(checked.command.arguments) !==
      JSON.stringify([
        join(directory, "tools/check-protected-quality.ts"),
        trusted.candidate,
      ])
  )
    throw new Error("untrusted-static-command");
}

export interface ScenarioObservation {
  readonly id: string;
  readonly outcome: "passed" | "failed";
  readonly verifier: string;
  readonly candidate: string;
}

export function checkScenarios(
  observations: readonly ScenarioObservation[],
  plan: AcceptancePlan,
  bound: { readonly verifier: string; readonly candidate: string },
): void {
  for (const id of plan.scenarios) {
    const matches = observations.filter((observation) => observation.id === id);
    const [observation] = matches;
    if (matches.length !== 1 || observation?.outcome !== "passed")
      throw new Error(`missing-controller-scenario: ${id}`);
    if (
      observation.verifier !== bound.verifier ||
      observation.candidate !== bound.candidate
    )
      throw new Error(`stale-controller-scenario: ${id}`);
  }
}

export function parseReport(output: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return Object.fromEntries(Object.entries(value));
  } catch {
    return null;
  }
}
