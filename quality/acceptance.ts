import type { AcceptanceArtifact } from "./acceptance-artifacts.ts";
import type {
  ScenarioObservation,
  StaticEvidence,
} from "./acceptance-evidence.ts";
import type { VerificationReceipt } from "./verification-types.ts";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { checkArtifacts } from "./acceptance-artifacts.ts";
import { checkDiagnosticEvidence } from "./acceptance-diagnostics.ts";
import { checkScenarios, checkStaticEvidence } from "./acceptance-evidence.ts";
import { snapshotTree } from "./tree-snapshot.ts";
import { readVerifierActivation } from "./verifier-activation.ts";

export interface AcceptanceEvidence {
  readonly candidate: string;
  readonly static: StaticEvidence;
  readonly diagnostics: VerificationReceipt;
  readonly scenarios: readonly ScenarioObservation[];
  readonly artifacts: readonly AcceptanceArtifact[];
}

export interface AcceptanceVerdict {
  readonly verdict: "accepted";
  readonly identity: string;
  readonly activation: string;
  readonly plan: string;
  readonly candidate: string;
}

export async function consumeAcceptance(
  state: string,
  candidate: string,
  evidence: AcceptanceEvidence,
): Promise<AcceptanceVerdict> {
  const directory = await realpath(candidate);
  const protectedState = await realpath(state);
  for (const path of [
    relative(directory, protectedState),
    relative(protectedState, directory),
  ]) {
    if (path !== ".." && !path.startsWith(`..${sep}`))
      throw new Error("overlapping-acceptance-state");
  }
  const activation = await readVerifierActivation(protectedState);
  const snapshot = await snapshotTree(directory);
  const current = snapshot.identity;
  if (current !== evidence.candidate || current !== evidence.static.candidate)
    throw new Error("stale-acceptance-candidate");
  const executable = await realpath(process.execPath);
  checkStaticEvidence(evidence.static, activation, {
    candidate: directory,
    executable,
  });
  await checkDiagnosticEvidence(evidence.diagnostics, activation, {
    directory,
    snapshot,
    executable,
  });
  checkScenarios(evidence.scenarios, activation.plan, {
    verifier: activation.verifier.identity,
    candidate: current,
  });
  await checkArtifacts(
    evidence.artifacts,
    activation.plan.artifacts,
    directory,
  );
  const record = {
    verdict: "accepted" as const,
    activation: activation.identity,
    plan: activation.plan.identity,
    candidate: current,
  };
  return {
    ...record,
    identity: createHash("sha256")
      .update(JSON.stringify({ ...record, evidence }))
      .digest("hex"),
  };
}
