import { openWait, type TurnWait, type WaitingTurn } from "../turn-launch.ts";

export function waitEnd(wait: TurnWait): number | undefined {
  const start = Date.parse(wait.waitingAt);
  return Number.isNaN(start) ? undefined : start + wait.waitMilliseconds;
}

export function waitingTurn(
  operationId: string,
  turn: { readonly started: unknown; readonly result: unknown },
): WaitingTurn | undefined {
  const wait = openWait(turn);
  const endsAt = wait === undefined ? undefined : waitEnd(wait);
  if (wait === undefined || endsAt === undefined) return undefined;
  const waitEndsAt = new Date(endsAt).toISOString();
  return { operationId, ...wait, waitEndsAt };
}
