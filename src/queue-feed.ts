import { record } from "./protocol.ts";
import {
  ticketIdentifier,
  validFeedPick,
  type FeedPick,
} from "./submission.ts";
export type { FeedPick } from "./submission.ts";

export interface FeedSkipped {
  readonly id: string;
  readonly reason: string;
}

export interface FeedResult {
  readonly picks: readonly FeedPick[];
  readonly skipped: readonly FeedSkipped[];
}

export const internalFeedPrefix = "queue-feed//";

function validSkipped(value: unknown): value is FeedSkipped {
  const item = record(value);
  return (
    item !== undefined &&
    Object.keys(item).length === 2 &&
    typeof item["id"] === "string" &&
    ticketIdentifier.test(item["id"]) &&
    item["id"] !== "next" &&
    typeof item["reason"] === "string" &&
    Array.from(item["reason"]).length <= 200
  );
}

export function checkedFeedResult(value: unknown): FeedResult | undefined {
  const fields = record(value);
  if (fields === undefined || Object.keys(fields).length !== 2)
    return undefined;
  const { picks, skipped } = fields;
  if (
    !Array.isArray(picks) ||
    picks.length > 20 ||
    !picks.every(validFeedPick) ||
    !Array.isArray(skipped) ||
    skipped.length > 50 ||
    !skipped.every(validSkipped)
  )
    return undefined;
  const result = { picks, skipped };
  return new TextEncoder().encode(JSON.stringify(result)).length <= 262_144
    ? result
    : undefined;
}
