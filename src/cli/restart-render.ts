import { record, type Fields } from "../protocol.ts";
import { show } from "./terminal-text.ts";

export function restartPendingText(restart: Fields): string {
  const count = Number(restart["activeRuns"]);
  const runs = count === 1 ? "run" : "runs";
  return `Restart pending: ${String(count)} ${runs} active`;
}

function pendingLines(restart: Fields | undefined): readonly string[] {
  return restart === undefined ? [] : [restartPendingText(restart)];
}

export function serviceOf(status: Fields): {
  readonly serviceVersion?: string;
  readonly restart?: Fields;
} {
  const version = status["serviceVersion"];
  const restart = record(status["restart"]);
  return {
    ...(typeof version === "string" ? { serviceVersion: version } : {}),
    ...(restart === undefined ? {} : { restart }),
  };
}

export function serviceLines(result: Fields): readonly string[] {
  const startedAt = result["serviceStartedAt"];
  return [
    ...(typeof startedAt === "string"
      ? [
          `Service: commit ${show(result["serviceCommit"] ?? "unknown")}, started at ${startedAt}`,
        ]
      : []),
    ...pendingLines(record(result["restart"])),
  ];
}

export function restartLines(result: Fields): readonly string[] {
  const restart = record(result["restart"]);
  if (restart?.["state"] === "cancelled") return ["Restart: cancelled"];
  if (restart?.["state"] === "none") return ["Restart: none pending"];
  return pendingLines(restart);
}

function commitOf(fields: Fields | undefined): unknown {
  return fields?.["serviceCommit"] ?? null;
}

export function restartedLines(
  before: Fields | undefined,
  after: Fields,
): readonly string[] {
  return [
    `Restarted: commit ${show(commitOf(before) ?? "unknown")} -> ${show(commitOf(after) ?? "unknown")}`,
    `Started at: ${show(after["serviceStartedAt"])}`,
  ];
}

export function restartedJson(
  before: Fields | undefined,
  after: Fields,
): Fields {
  return {
    kind: "restarted",
    previousCommit: commitOf(before),
    commit: commitOf(after),
    startedAt: after["serviceStartedAt"] ?? null,
  };
}
