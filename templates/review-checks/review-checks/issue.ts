import type { CycleOutcome } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { record, resultJson } from "./input.ts";

export const checkLabel = "cloving: check";

export async function createIssue(request: {
  readonly cycleId: string;
  readonly text: string;
}): Promise<number> {
  const number = record(
    resultJson(
      await protectedEffect({
        capability: "github",
        method: "create-issue",
        scope: { phase: "issue", operation: "post", round: 1 },
        target: request.cycleId,
        units: 1,
        payload: JSON.stringify({ text: request.text }),
      }),
      "invalid-issue-result",
    ),
    "invalid-issue-result",
  )["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-issue-result");
  return number;
}

export async function labelIssue(request: {
  readonly cycleId: string;
  readonly number: number;
}): Promise<void> {
  resultJson(
    await protectedEffect({
      capability: "github",
      method: "label",
      scope: { phase: "issue", operation: "label", round: 1 },
      target: request.cycleId,
      units: 1,
      payload: JSON.stringify({
        number: request.number,
        add: [checkLabel],
        remove: [],
      }),
    }),
    "invalid-label-result",
  );
}

export async function checkIssue(request: {
  readonly cycleId: string;
  readonly text: string;
}): Promise<CycleOutcome> {
  const number = await createIssue(request);
  await labelIssue({ cycleId: request.cycleId, number: number });
  return {
    kind: "handoff_requested",
    cycleId: request.cycleId,
    promotionId: `issue-${String(number)}`,
    report: `Created the check issue #${String(number)}.`,
  };
}
