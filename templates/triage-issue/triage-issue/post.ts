import type { CycleOutcome } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import { blocked, resultText } from "./input.ts";
import type { Triage } from "./verdict.ts";

const triagedLabel = "cloving: triaged";
const privacyReason = "private-path-in-change";

export async function labelIssue(
  triage: Triage,
  labels: readonly string[],
): Promise<void> {
  resultText(
    await protectedEffect({
      capability: "github",
      method: "label",
      scope: { phase: "triage", operation: "label", round: 1 },
      target: triage.cycleId,
      units: 1,
      payload: JSON.stringify({
        number: triage.issue,
        add: labels,
        remove: [],
      }),
    }),
  );
}

function triaged(triage: Triage, result: string): CycleOutcome {
  return {
    kind: "handoff_requested",
    cycleId: triage.cycleId,
    promotionId: `triage-${String(triage.issue)}`,
    report: `Triage of #${String(triage.issue)}: ${triage.verdict}. ${result}`,
  };
}

export async function postReply(triage: Triage): Promise<CycleOutcome> {
  const posted = await protectedEffect({
    capability: "github",
    method: "comment-issue",
    scope: { phase: "triage", operation: "comment", round: 1 },
    target: triage.cycleId,
    units: 1,
    payload: JSON.stringify({ number: triage.issue, body: triage.body }),
  });
  if (posted.kind !== "completed" && posted.reason === privacyReason) {
    await labelIssue(triage, [triagedLabel]);
    return blocked(triage, privacyReason);
  }
  resultText(posted);
  await labelIssue(triage, [triagedLabel, triage.label]);
  return triaged(triage, "The reply is posted.");
}

export async function askPerson(triage: Triage): Promise<CycleOutcome> {
  const decision = await waitForDecision({
    gateId: `triage:${triage.cycleId}`,
    kind: "approval",
    prompt: `Post this triage reply on issue #${String(triage.issue)}?\n\nVerdict: ${triage.verdict}\n\n${triage.body}`,
  });
  if (decision.decision === "approved") return await postReply(triage);
  await labelIssue(triage, [triagedLabel]);
  return triaged(
    triage,
    "The reply is not approved, so only cloving: triaged is added.",
  );
}

export async function postAtOnce(triage: Triage): Promise<CycleOutcome> {
  return await postReply(triage);
}
