import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorObservation } from "../doctor-report.ts";
import {
  retentionSettings,
  sharedRecordFolders,
  type RetentionSettings,
} from "../record-retention.ts";

interface TreeUse {
  readonly size: number;
  readonly changedAt: number;
}

interface KindUse {
  readonly kind: string;
  readonly size: number;
  readonly folders: number;
  readonly oldest: number;
}

const kinds = ["journal", "github"] as const;
const dayMilliseconds = 86_400_000;
const warningBytes = 1_000_000_000;
const units = [
  ["GB", 1_000_000_000],
  ["MB", 1_000_000],
  ["kB", 1_000],
] as const;

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function sizeText(bytes: number): string {
  const unit = units.find(([, scale]) => bytes >= scale);
  if (unit === undefined) return counted(bytes, "byte");
  return `${(bytes / unit[1]).toFixed(1)} ${unit[0]}`;
}

async function treeUse(path: string): Promise<TreeUse> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => lstat(join(entry.parentPath, entry.name))),
  );
  return files.reduce(
    (use, file) => ({
      size: use.size + file.size,
      changedAt: Math.max(use.changedAt, file.mtimeMs),
    }),
    { size: 0, changedAt: Number.NEGATIVE_INFINITY },
  );
}

async function entryUse(
  path: string,
): Promise<TreeUse & { readonly folder: boolean }> {
  const entry = await lstat(path);
  if (!entry.isDirectory())
    return { size: entry.size, changedAt: Number.NaN, folder: false };
  return { ...(await treeUse(path)), folder: true };
}

async function kindUse(state: string, kind: string): Promise<KindUse> {
  const folder = join(state, kind);
  const names = await readdir(folder).catch(() => []);
  const uses = await Promise.all(
    names.map(async (name) => {
      const use = await entryUse(join(folder, name));
      const shared = sharedRecordFolders.includes(`${kind}/${name}`);
      return { ...use, record: use.folder && !shared };
    }),
  );
  const records = uses.filter((use) => use.record);
  return {
    kind,
    size: uses.reduce((total, use) => total + use.size, 0),
    folders: records.length,
    oldest: records
      .map((use) => use.changedAt)
      .filter(Number.isFinite)
      .reduce((oldest, changedAt) => Math.min(oldest, changedAt), Infinity),
  };
}

function settingsText(settings: RetentionSettings, state: string): string {
  const archive = settings.archiveFolder ?? `null (${join(state, "archive")})`;
  return `retention.days ${String(settings.days)}, retention.action ${settings.action}, retention.archiveFolder ${archive}`;
}

function ageText(oldest: number, now: number): string {
  if (!Number.isFinite(oldest)) return "no kept folders";
  const days = Math.floor((now - oldest) / dayMilliseconds);
  return `oldest kept folder ${counted(days, "day")} old`;
}

export async function retentionObservation(
  state: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<DoctorObservation> {
  try {
    const settings = retentionSettings(environment);
    const uses = await Promise.all(kinds.map((kind) => kindUse(state, kind)));
    const oldest = Math.min(...uses.map((use) => use.oldest));
    const unlimited =
      settings.days === null &&
      uses.reduce((total, use) => total + use.size, 0) > warningBytes;
    return {
      result: unlimited ? "warn" : "ok",
      detail: [
        uses
          .map(
            (use) =>
              `${use.kind} ${sizeText(use.size)} in ${counted(use.folders, "folder")}`,
          )
          .join("; "),
        ageText(oldest, Date.now()),
        settingsText(settings, state),
        ...(unlimited
          ? ["the records are larger than 1 GB and retention.days is null"]
          : []),
      ].join("; "),
    };
  } catch (error) {
    return {
      result: "fail",
      detail: error instanceof Error ? error.message : "Records unavailable",
    };
  }
}
