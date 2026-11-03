import { operationScope } from "./operation-identity.ts";

export interface StoredRun {
  readonly status: string;
  readonly endedAt: number | null;
}

export interface RecordFolder {
  readonly started: unknown;
  readonly changedAt: number;
}

export interface RetentionContext {
  readonly runs: Readonly<Record<string, StoredRun>>;
  readonly now: number;
  readonly days: number;
}

export type RetentionVerdict = "due" | "kept" | "skipped" | "unreadable";

export interface RetentionSettings {
  readonly days: number | null;
  readonly action: "archive" | "delete";
  readonly archiveFolder: string | null;
}

export const defaultRetention: RetentionSettings = {
  days: 30,
  action: "archive",
  archiveFolder: null,
};

type Variables = Readonly<Record<string, string | undefined>>;

const dayMilliseconds = 86_400_000;
const finished: readonly string[] = ["completed", "failed", "cancelled"];

export function folderRunId(started: unknown): string | undefined {
  const runId: unknown = Reflect.get(Object(started), "runId");
  if (typeof runId === "string") return runId;
  const operationId: unknown = Reflect.get(Object(started), "operationId");
  if (typeof operationId !== "string") return undefined;
  return operationScope(operationId)?.run;
}

export function retentionVerdict(
  folder: RecordFolder,
  context: RetentionContext,
): RetentionVerdict {
  const runId = folderRunId(folder.started);
  const run =
    runId !== undefined && Object.hasOwn(context.runs, runId)
      ? context.runs[runId]
      : undefined;
  if (run === undefined) return "unreadable";
  if (!finished.includes(run.status)) return "skipped";
  const limit = context.now - context.days * dayMilliseconds;
  const endedAt = run.endedAt ?? Number.NaN;
  return endedAt < limit && folder.changedAt < limit ? "due" : "kept";
}

function refused(variable: string, expected: string): never {
  throw new Error(`invalid-setting: ${variable} must be ${expected}`);
}

function retentionDays(value: string | undefined): number | null {
  if (value === undefined) return defaultRetention.days;
  if (value === "null") return null;
  const days = Number(value);
  if (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(days)) return days;
  return refused(
    "CLOVING_RETENTION_DAYS",
    "a whole number of at least 1 or null",
  );
}

function retentionAction(
  value: string | undefined,
): RetentionSettings["action"] {
  if (value === undefined) return defaultRetention.action;
  if (value === "archive" || value === "delete") return value;
  return refused("CLOVING_RETENTION_ACTION", "archive or delete");
}

function archiveFolder(value: string | undefined): string | null {
  if (value === undefined || value === "null") return null;
  if (value.startsWith("/")) return value;
  return refused(
    "CLOVING_RETENTION_ARCHIVE_FOLDER",
    "an absolute path or null",
  );
}

export function retentionSettings(variables: Variables): RetentionSettings {
  return {
    days: retentionDays(variables["CLOVING_RETENTION_DAYS"]),
    action: retentionAction(variables["CLOVING_RETENTION_ACTION"]),
    archiveFolder: archiveFolder(variables["CLOVING_RETENTION_ARCHIVE_FOLDER"]),
  };
}
