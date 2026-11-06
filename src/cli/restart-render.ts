import { record, type Fields } from "../protocol.ts";
import { show } from "./terminal-text.ts";
import { listing } from "./run-command-render.ts";

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

const cancelLines: Readonly<Record<string, string>> = {
  cancelled: "Restart: cancelled",
  none: "Restart: none pending",
  started: "Restart: started, cannot cancel",
};

function unresumableLines(restart: Fields | undefined): readonly string[] {
  const runs = restart?.["unresumableRuns"];
  return Array.isArray(runs)
    ? [`Runs with a turn that cannot resume: ${listing(runs)}`]
    : [];
}

export function restartLines(result: Fields): readonly string[] {
  const restart = record(result["restart"]);
  const cancelled = cancelLines[String(restart?.["state"])];
  if (cancelled !== undefined) return [cancelled];
  return [...pendingLines(restart), ...unresumableLines(restart)];
}

function commitOf(fields: Fields): unknown {
  return fields["serviceCommit"] ?? null;
}

export function restartedLines(
  before: Fields,
  after: Fields,
): readonly string[] {
  return [
    `Restarted: commit ${show(commitOf(before) ?? "unknown")} -> ${show(commitOf(after) ?? "unknown")}`,
    `Started at: ${show(after["serviceStartedAt"])}`,
  ];
}

export function restartedJson(before: Fields, after: Fields): Fields {
  return {
    kind: "restarted",
    previousCommit: commitOf(before),
    commit: commitOf(after),
    startedAt: after["serviceStartedAt"] ?? null,
  };
}
