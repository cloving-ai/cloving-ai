import type { CycleOutcome } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import { completedText, failure, jsonValue, record } from "./fields.ts";

export const docsLabel = "cloving: docs";

export async function createIssue(request: {
  readonly cycleId: string;
  readonly text: string;
}): Promise<number> {
  const bad = "invalid-issue-result";
  const result = await protectedEffect({
    capability: "github",
    method: "create-issue",
    scope: { phase: "ticket", operation: "post", round: 1 },
    target: request.cycleId,
    units: 1,
    payload: JSON.stringify({ text: request.text }),
  });
  const issue = record(jsonValue(completedText(result, bad), bad), bad);
  const number = issue["number"];
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : failure(bad);
}

export async function labelIssue(request: {
  readonly cycleId: string;
  readonly number: number;
}): Promise<void> {
  const result = await protectedEffect({
    capability: "github",
    method: "label",
    scope: { phase: "ticket", operation: "label", round: 1 },
    target: request.cycleId,
    units: 1,
    payload: JSON.stringify({
      number: request.number,
      add: [docsLabel],
      remove: [],
    }),
  });
  completedText(result, "invalid-label-result");
}

export async function postTicket(request: {
  readonly cycleId: string;
  readonly text: string;
}): Promise<CycleOutcome> {
  const number = await createIssue(request);
  await labelIssue({ cycleId: request.cycleId, number: number });
  return {
    kind: "handoff_requested",
    cycleId: request.cycleId,
    promotionId: `issue-${String(number)}`,
    report: `Created the docs issue #${String(number)}.`,
  };
}
