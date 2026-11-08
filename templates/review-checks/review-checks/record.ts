import { runCommand } from "cloving/workflows/steps/run-command";
import type { Decided } from "./decision.ts";
import { count, record, resultJson } from "./input.ts";

export async function recordDecisions(
  decided: readonly Decided[],
): Promise<void> {
  const recorded = record(
    resultJson(
      await runCommand({
        scope: { phase: "checks", operation: "record", round: 1 },
        name: "review-checks-record",
        input: {
          decisions: decided.map((item) => ({
            name: item.suggestion.name,
            kind: item.suggestion.kind,
            rule: item.suggestion.rule,
            shape: item.suggestion.shape,
            decision: item.decision,
            links: item.suggestion.links,
          })),
        },
      }),
      "invalid-record-result",
    ),
    "invalid-record-result",
  );
  if (count(recorded["recorded"], "invalid-record-result") !== decided.length)
    throw new Error("invalid-record-result");
}
