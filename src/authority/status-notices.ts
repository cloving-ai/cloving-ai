import type { Observation } from "./details.ts";
import { assessed, type Assessment } from "./status-input.ts";

function runWaitAssessment(
  observation: Observation | null,
): Assessment | undefined {
  if (observation?.condition === "waiting-run")
    return assessed("waiting-run", {
      code: "awaiting-run",
      detail: `The run waits for run ${observation.evidence ?? "unknown"}.`,
      nextAction: "await-run",
      nextActionAt: observation.retryAt,
      humanInputCanHelp: false,
    });
  return undefined;
}

function gitRetryAssessment(
  observation: Observation | null,
): Assessment | undefined {
  if (observation?.reason !== "git-network-retry") return undefined;
  const command = (observation.evidence ?? "git").replace("/", " ");
  return assessed("working", {
    code: observation.reason,
    detail: `${command} failed, retry ${String(observation.attempt)} of ${String(observation.limit)}.`,
    nextAction: "retry-git-call",
    nextActionAt: observation.retryAt,
    humanInputCanHelp: false,
  });
}

function mergeQueueAssessment(
  observation: Observation | null,
): Assessment | undefined {
  if (observation?.reason !== "github-merge-queued") return undefined;
  const [, state, position] = String(observation.evidence).split("/");
  return assessed("working", {
    code: observation.reason,
    detail: `In the merge queue, position ${String(position)}. Queue state: ${String(state)}.`,
    nextAction: null,
    humanInputCanHelp: false,
  });
}

export function noticeAssessment(
  observation: Observation | null,
): Assessment | undefined {
  return (
    runWaitAssessment(observation) ??
    gitRetryAssessment(observation) ??
    mergeQueueAssessment(observation)
  );
}
