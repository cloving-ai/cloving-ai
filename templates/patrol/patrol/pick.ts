import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import type { PatrolInput, StuckPull } from "./status.ts";

export interface PickRequest {
  readonly input: PatrolInput;
  readonly pulls: readonly StuckPull[];
}

export function pullText(pull: StuckPull, index: number): string {
  const review =
    pull.score === null ? "no review score" : `review ${String(pull.score)}/5`;
  return `${String(index + 1)}. Pull request #${String(pull.number)} on ${pull.branch}: ${pull.state} (${pull.reason}), head ${pull.head.slice(0, 12)}, ${review}.`;
}

function chosen(
  pulls: readonly StuckPull[],
  answer: string,
): readonly StuckPull[] {
  if (answer === "all") return pulls;
  if (!/^\d+(?:\s*,\s*\d+)*$/.test(answer)) return [];
  const numbers = Array.from(
    new Set(answer.split(",").map((item) => Number(item.trim()))),
  );
  return numbers.flatMap((number) => {
    const pull = number >= 1 ? pulls.at(number - 1) : undefined;
    return pull === undefined ? [] : [pull];
  });
}

export async function askPerson(
  request: PickRequest,
): Promise<readonly StuckPull[]> {
  if (request.pulls.length === 0) return [];
  const result = await waitForDecision({
    gateId: `patrol:${request.input.cycleId}`,
    kind: "question",
    prompt: [
      "Rescue stuck pull requests. Answer the numbers to rescue, separated by commas, or all, or none. One pass hands off at most four rescues.",
    ]
      .concat(request.pulls.map((pull, index) => pullText(pull, index)))
      .join("\n\n"),
  });
  if (result.decision !== "answered" && result.decision !== "approved")
    return [];
  return chosen(request.pulls, result.answer?.trim().toLowerCase() ?? "");
}

export async function pickAll(
  request: PickRequest,
): Promise<readonly StuckPull[]> {
  return await Promise.resolve(request.pulls);
}
