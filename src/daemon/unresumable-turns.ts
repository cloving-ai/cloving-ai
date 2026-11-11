import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { operationScope } from "../operation-identity.ts";
import { readRecord } from "./operation-journal.ts";
import { attachableLaunch } from "./claude-attach.ts";
import {
  readResume,
  recordedField,
  resumableHarness,
} from "./claude-recovery.ts";

function noEntries(error: unknown): readonly string[] {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return [];
  throw error;
}

async function resumable(folder: string, started: unknown): Promise<boolean> {
  const launch = await attachableLaunch(folder, started);
  if (launch !== undefined && launch !== "gone") return true;
  if (!resumableHarness(recordedField(started, "harness"))) return false;
  return (await readResume(folder, started)) !== undefined;
}

async function unresumableRun(folder: string): Promise<string | undefined> {
  const started = await readRecord(folder, "started.json");
  if (started === undefined) return undefined;
  if ((await readRecord(folder, "result.json")) !== undefined) return undefined;
  if (await resumable(folder, started)) return undefined;
  const operationId = recordedField(started, "operationId");
  if (typeof operationId !== "string") return undefined;
  return operationScope(operationId)?.run;
}

export async function unresumableRuns(
  directory: string,
): Promise<readonly string[]> {
  const journal = join(directory, "journal");
  const names = await readdir(journal).catch(noEntries);
  const runs = await Promise.all(
    names.map((name) => unresumableRun(join(journal, name))),
  );
  return [...new Set(runs.filter((run) => run !== undefined))].toSorted();
}
