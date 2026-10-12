import {
  assessed,
  type Assessment,
  type OperationSummary,
  type StatusInput,
} from "./status-input.ts";
import type { RunClosure } from "./stop-sequence.ts";

const unknownResults: readonly (string | null)[] = [
  null,
  "failed",
  "stale-epoch",
];

export function unresolved(
  operations: readonly OperationSummary[],
): readonly string[] {
  return operations
    .filter(
      (operation) =>
        !operation.outcomes.includes("sent") &&
        operation.outcomes.some((outcome) => unknownResults.includes(outcome)),
    )
    .map((operation) => operation.operationId);
}

function stoppedOperation(input: StatusInput): string | null {
  const observation = input.details?.observation ?? null;
  return observation?.condition === "stopped" ? observation.operationId : null;
}

export function unresolvedEffects(input: StatusInput): readonly string[] {
  if (input.closure !== null) return input.closure.unresolved;
  const stopped = stoppedOperation(input);
  return unresolved(input.operations).filter(
    (operationId) => operationId !== stopped,
  );
}

const resolved: RunClosure = {
  closure: "cancelled",
  unresolved: [],
  open: false,
};

const cancelling = (
  code: string,
  rest: Pick<Assessment, "nextAction" | "humanInputCanHelp" | "detail">,
): Assessment => assessed("cancelling", { code, ...rest });

export function cancelled(input: StatusInput): Assessment {
  const closure = input.closure ?? resolved;
  if (closure.open)
    return cancelling("delivery-in-flight", {
      nextAction: "reconcile-effect",
      humanInputCanHelp: false,
    });
  if (closure.closure === "stop-unconfirmed")
    return cancelling("stop-unconfirmed", {
      nextAction: "confirm-worker-stop",
      humanInputCanHelp: true,
    });
  if (closure.unresolved.length > 0)
    return cancelling("delivery-outcome-unknown", {
      detail:
        "The run is dropped. A dispatch has no known result. A stop report of that operation or a later reconciliation resolves it.",
      nextAction: "reconcile-effect",
      humanInputCanHelp: false,
    });
  if (closure.closure === "stop-not-observed")
    return cancelling("stop-not-observed", {
      nextAction: "observe-worker-stop",
      humanInputCanHelp: false,
    });
  return assessed("cancelled", {
    code: "run-cancelled",
    nextAction: null,
    humanInputCanHelp: false,
  });
}
