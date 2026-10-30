import { instantMilliseconds, isInstant } from "./instants.ts";
import {
  timedOut,
  type CommandWaitState,
  type CommandWaitsState,
} from "./command-waits.ts";
import type { AuthorityState } from "./transitions.ts";
import { isFinal, type EffectChange, type Operation } from "./operations.ts";
import type { AuthorityEvent } from "./transitions.ts";

type Output =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly value: string }
  | { readonly kind: "failed"; readonly reason: string };

function output(text: string | undefined): Output {
  try {
    const value: unknown = JSON.parse(text ?? "");
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return { kind: "failed", reason: "command-wait-invalid-output" };
    const ready: unknown = Reflect.get(value, "ready");
    if (ready === false) return { kind: "pending" };
    if (ready === true)
      return {
        kind: "ready",
        value: JSON.stringify(Reflect.get(value, "value") ?? null),
      };
    return { kind: "failed", reason: "command-wait-invalid-output" };
  } catch {
    return { kind: "failed", reason: "command-wait-invalid-output" };
  }
}

function settled(
  wait: CommandWaitState,
  check: { readonly event: AuthorityEvent; readonly operation: Operation },
): CommandWaitState {
  const { event, operation } = check;
  const now = instantMilliseconds(event.recordedAt);
  const recorded = { ...wait, checkOperation: null, lastCheckSettledAt: now };
  if (now >= wait.deadline) return timedOut(recorded);
  const result: Output =
    operation.status === "completed"
      ? output(event.payload["commandOutput"])
      : { kind: "failed", reason: operation.reason ?? "command-interrupted" };
  if (result.kind === "pending")
    return { ...recorded, nextCheckAt: now + wait.pollEverySeconds * 1000 };
  return {
    ...recorded,
    state: result.kind === "ready" ? "completed" : "failed",
    settledAt: now,
    nextCheckAt: null,
    result: result.kind === "ready" ? result.value : null,
    reason: result.kind === "failed" ? result.reason : null,
  };
}

export function settledCommandWaits(
  waits: CommandWaitsState,
  check: {
    readonly event: AuthorityEvent;
    readonly operation: Operation | undefined;
  },
): CommandWaitsState {
  const { event, operation } = check;
  if (
    operation === undefined ||
    !isFinal(operation) ||
    !isInstant(event.recordedAt)
  )
    return waits;
  return Object.fromEntries(
    Object.entries(waits).map(([key, wait]) => [
      key,
      wait.runId === event.runId &&
      wait.checkOperation === operation.operationId &&
      wait.state === "waiting"
        ? settled(wait, { event, operation })
        : wait,
    ]),
  );
}

export function waitEffectTime(
  waits: CommandWaitsState,
  event: AuthorityEvent,
): boolean {
  const check = Object.values(waits).some(
    (wait) =>
      wait.runId === event.runId &&
      wait.checkOperation === event.payload["operationId"],
  );
  return !check || isInstant(event.recordedAt);
}

export function waitEffectChange(
  state: AuthorityState,
  settlement: { readonly event: AuthorityEvent; readonly result: EffectChange },
): { readonly commandWaits?: CommandWaitsState } {
  if (
    state.commandWaits === undefined ||
    settlement.result.disposition?.disposition !== "applied"
  )
    return {};
  return {
    commandWaits: settledCommandWaits(state.commandWaits, {
      event: settlement.event,
      operation:
        settlement.result.effects.operations[
          settlement.event.payload["operationId"] ?? ""
        ],
    }),
  };
}
