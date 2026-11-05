import { record } from "../protocol.ts";
import { visible } from "./terminal-text.ts";

export function stallDescription(value: unknown): string | undefined {
  const check = record(value);
  if (check?.["result"] !== "stalled") return undefined;
  const resources = Object.entries(record(check["resources"]) ?? {})
    .map(([name, count]) => `${visible(name)}:${visible(count)}`)
    .join(",");
  return `the check at ${visible(check["checkedAt"])} had no answer after ${visible(check["milliseconds"])} ms; resources ${resources || "none"}`;
}

export function threadPoolLines(value: unknown): readonly string[] {
  const stall = stallDescription(value);
  return stall === undefined ? [] : [`Thread pool: stalled; ${stall}`];
}
