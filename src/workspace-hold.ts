import { record, type Fields } from "./protocol.ts";
import type { WorkspaceHold } from "./queue-room.ts";
import { queueSpending } from "./queue-spend.ts";
import type { WorkspaceLimits } from "./workspace.ts";

export type MemberReading =
  | {
      readonly kind: "read";
      readonly name: string;
      readonly busy: number;
      readonly spentUsd: number;
    }
  | {
      readonly kind: "unknown";
      readonly name: string;
      readonly detail: string;
    };

export interface WorkspaceReading {
  readonly members: readonly MemberReading[];
  readonly permits: number;
}

function laneHold(
  limit: number | undefined,
  busy: number,
): WorkspaceHold | undefined {
  if (limit === undefined || busy < limit) return undefined;
  return {
    reason: "workspace-lanes",
    busy,
    limit,
    text: `Held: ${String(busy)} of ${String(limit)} workspace lanes busy`,
  };
}

function spendHold(
  limitUsd: number | undefined,
  costs: readonly number[],
): WorkspaceHold | undefined {
  if (limitUsd === undefined) return undefined;
  const { spentUsd, holding } = queueSpending(costs, limitUsd);
  if (!holding) return undefined;
  return {
    reason: "workspace-spend",
    spentUsd,
    limitUsd,
    text: `Held: workspace spend ${String(spentUsd)} USD in 24 hours, 85 percent of the limit ${String(limitUsd)} USD`,
  };
}

export function workspaceHold(
  limits: WorkspaceLimits,
  reading: WorkspaceReading,
): WorkspaceHold | undefined {
  if (limits.lanes === undefined && limits.dailySpendLimitUsd === undefined)
    return undefined;
  const read = reading.members.flatMap((member) =>
    member.kind === "read" ? [member] : [],
  );
  const unknown = reading.members.find((member) => member.kind === "unknown");
  if (unknown !== undefined)
    return {
      reason: "workspace-unknown",
      text: `Held: the workspace cannot read ${unknown.name}: ${unknown.detail}`,
    };
  const busy = read.reduce(
    (total, member) => total + member.busy,
    reading.permits,
  );
  return (
    laneHold(limits.lanes, busy) ??
    spendHold(
      limits.dailySpendLimitUsd,
      read.map((member) => member.spentUsd),
    )
  );
}

function numbers(fields: Fields, names: readonly string[]): boolean {
  return names.every((name) => typeof fields[name] === "number");
}

export function permitHoldOf(value: unknown): WorkspaceHold | undefined {
  const fields = record(value);
  if (fields === undefined || typeof fields["text"] !== "string")
    return undefined;
  const text = fields["text"];
  if (fields["reason"] === "workspace-unknown")
    return { reason: "workspace-unknown", text };
  if (
    fields["reason"] === "workspace-lanes" &&
    numbers(fields, ["busy", "limit"])
  )
    return {
      reason: "workspace-lanes",
      busy: Number(fields["busy"]),
      limit: Number(fields["limit"]),
      text,
    };
  if (
    fields["reason"] === "workspace-spend" &&
    numbers(fields, ["spentUsd", "limitUsd"])
  )
    return {
      reason: "workspace-spend",
      spentUsd: Number(fields["spentUsd"]),
      limitUsd: Number(fields["limitUsd"]),
      text,
    };
  return undefined;
}
