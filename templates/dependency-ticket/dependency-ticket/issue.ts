import type { ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export interface TicketInput {
  readonly cycleId: string;
  readonly input: { readonly text: string };
}

export const securityLabel = "cloving: security";

function effectText(result: ProtectedResult): string {
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  if (result.result === null) throw new Error("invalid-issue-result");
  return result.result;
}

function parsedIssue(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error("invalid-issue-result");
  }
}

function issueNumber(text: string): number {
  const value = parsedIssue(text);
  const number =
    typeof value === "object" && value !== null && "number" in value
      ? value.number
      : null;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-issue-result");
  return number;
}

export async function createIssue(input: TicketInput): Promise<number> {
  return issueNumber(
    effectText(
      await protectedEffect({
        capability: "github",
        method: "create-issue",
        scope: { phase: "ticket", operation: "post", round: 1 },
        target: input.cycleId,
        units: 1,
        payload: JSON.stringify({ text: input.input.text }),
      }),
    ),
  );
}

export async function labelIssue(request: {
  readonly input: TicketInput;
  readonly number: number;
}): Promise<void> {
  effectText(
    await protectedEffect({
      capability: "github",
      method: "label",
      scope: { phase: "ticket", operation: "label", round: 1 },
      target: request.input.cycleId,
      units: 1,
      payload: JSON.stringify({
        number: request.number,
        add: [securityLabel],
        remove: [],
      }),
    }),
  );
}
