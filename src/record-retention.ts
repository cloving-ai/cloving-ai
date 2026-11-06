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

export interface RunTurns {
  readonly runId: string;
  readonly operationIds: readonly string[];
}

export type TurnDetails =
  | { readonly state: "archived"; readonly folder: string }
  | { readonly state: "deleted" };

export interface TurnFolders {
  readonly turns: number;
  readonly kept: number;
  readonly archived: string | undefined;
}

export const sharedRecordFolders: readonly string[] = [
  "journal/runs",
  "journal/targets",
];

export const bundleDigestPattern = /^[a-f0-9]{64}$/;

export const defaultRetention: RetentionSettings = {
  days: 30,
  action: "archive",
  archiveFolder: null,
};

type Variables = Readonly<Record<string, string | undefined>>;

const dayMilliseconds = 86_400_000;
const finished: readonly string[] = ["completed", "failed", "cancelled"];

export function folderRunId(started: unknown): string | undefined {
  if (typeof started !== "object" || started === null) return undefined;
  if ("runId" in started && typeof started.runId === "string")
    return started.runId;
  if (!("operationId" in started) || typeof started.operationId !== "string")
    return undefined;
  return operationScope(started.operationId)?.run;
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
  return endedBefore(run, limit) && folder.changedAt < limit ? "due" : "kept";
}

function endedBefore(run: StoredRun, limit: number): boolean {
  return finished.includes(run.status) && (run.endedAt ?? Number.NaN) < limit;
}

export interface StoredBundle {
  readonly digest: string;
  readonly currentAt: number;
}

export interface BundleContext {
  readonly current: string | undefined;
  readonly pinned: readonly string[];
  readonly now: number;
  readonly days: number | null;
}

export function dueBundles(
  bundles: readonly StoredBundle[],
  context: BundleContext,
): string[] {
  const { current, pinned, days } = context;
  if (days === null) return [];
  const limit = context.now - days * dayMilliseconds;
  return bundles
    .filter(
      (bundle) =>
        bundle.digest !== current &&
        !pinned.includes(bundle.digest) &&
        bundle.currentAt < limit,
    )
    .map((bundle) => bundle.digest);
}

export function batchAfter(
  names: readonly string[],
  context: { readonly cursor: string; readonly size: number },
): readonly string[] {
  const rest = names.filter((name) => name > context.cursor);
  return (rest.length === 0 ? names : rest).slice(0, context.size);
}

export function turnDetails(
  found: TurnFolders,
  context: {
    readonly run: StoredRun | undefined;
    readonly retention: RetentionSettings;
    readonly now: number;
  },
): TurnDetails | undefined {
  if (found.archived !== undefined)
    return { state: "archived", folder: found.archived };
  if (found.turns === 0 || found.kept > 0) return undefined;
  if (context.retention.action !== "delete") return undefined;
  return retentionExpired(context.run, context)
    ? { state: "deleted" }
    : undefined;
}

export function retentionExpired(
  run: StoredRun | undefined,
  context: { readonly retention: RetentionSettings; readonly now: number },
): boolean {
  const { days } = context.retention;
  if (run === undefined || days === null) return false;
  return endedBefore(run, context.now - days * dayMilliseconds);
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
