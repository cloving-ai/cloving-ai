import { instantMilliseconds, isInstant } from "./instants.ts";
import { commandWaitKey, type CommandWaitState } from "./command-waits.ts";
import { withOperation, type Operation } from "./operations.ts";
import { applied, invalid, identity, type Handler } from "./reduction-state.ts";

export function commandWaitCheckId(wait: CommandWaitState): string {
  return identity({
    run: wait.runId,
    phase: "command-wait",
    operation: wait.name,
    round: wait.checkCount + 1,
  });
}

export function commandWaitCheckRefusal(
  wait: CommandWaitState | undefined,
  check: { readonly runStatus: string; readonly recordedAt: string },
): string | undefined {
  if (!isInstant(check.recordedAt)) return "invalid-recorded-time";
  if (wait === undefined) return "unknown-command-wait";
  const now = instantMilliseconds(check.recordedAt);
  if (now >= wait.deadline) return "command-wait-timeout";
  if (check.runStatus !== "running") return "command-wait-run-not-running";
  if (wait.state !== "waiting") return "command-wait-ended";
  if (wait.checkOperation !== null) return "command-wait-check-in-flight";
  if (wait.nextCheckAt === null || now < wait.nextCheckAt)
    return "command-wait-check-not-due";
  return undefined;
}

function operation(
  wait: CommandWaitState,
  check: { readonly sequence: number; readonly inputDigest: string },
): Operation {
  return {
    runId: wait.runId,
    operationId: commandWaitCheckId(wait),
    capability: "command",
    method: `run:${wait.command}`,
    target: wait.command,
    payload: wait.inputDigest,
    inputDigest: check.inputDigest,
    units: 1,
    recoveryLimit: 1,
    leaseKey: commandWaitCheckId(wait),
    status: "waiting",
    reason: "ready",
    attempts: 0,
    receipt: null,
    worker: null,
    result: null,
    requestedSequence: check.sequence,
    waitSequence: check.sequence,
    settledSequence: null,
  };
}

export const checkedCommandWait: Handler = (state, recorded) => {
  const { event, run } = recorded;
  const waits = state.commandWaits ?? {};
  const key = commandWaitKey(event.runId, event.payload["waitName"] ?? "");
  const wait = waits[key];
  const reason = commandWaitCheckRefusal(wait, {
    runStatus: run.status,
    recordedAt: event.recordedAt,
  });
  if (reason !== undefined || wait === undefined)
    return invalid(reason ?? "unknown-command-wait");
  const check = operation(wait, {
    sequence: event.sequence,
    inputDigest: event.payload["inputDigest"] ?? "",
  });
  if (state.effects.operations[check.operationId] !== undefined)
    return invalid("command-wait-operation-conflict");
  return applied(state, {
    ...recorded,
    commandWaits: {
      ...waits,
      [key]: {
        ...wait,
        checkCount: wait.checkCount + 1,
        checkOperation: check.operationId,
      },
    },
    effects: withOperation(state.effects, check),
    disposition: {
      operationId: check.operationId,
      disposition: "admitted",
      reason: null,
    },
  });
};
