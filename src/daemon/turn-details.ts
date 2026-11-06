import { stat } from "node:fs/promises";
import { join } from "node:path";
import { located } from "./operation-journal.ts";
import { archiveFolder, type SweepSettings } from "./record-sweep.ts";
import {
  retentionExpired,
  turnDetails,
  type RunTurns,
  type TurnDetails,
} from "../record-retention.ts";

export type TurnDetailsSettings = Pick<
  SweepSettings,
  "directory" | "retention" | "runs" | "now"
>;

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function present(
  journal: string,
  operationIds: readonly string[],
): Promise<number | undefined> {
  const found = await Promise.all(
    operationIds.map((operationId) =>
      stat(located(journal, operationId).folder).then(
        () => true,
        (error: unknown) => (absent(error) ? false : undefined),
      ),
    ),
  );
  if (found.includes(undefined)) return undefined;
  return found.filter(Boolean).length;
}

export function turnDetailsPlace(
  settings: TurnDetailsSettings,
): (turns: RunTurns) => Promise<TurnDetails | undefined> {
  return async ({ runId, operationIds }) => {
    const archive = join(archiveFolder(settings), "journal");
    const runs = await settings.runs([runId]);
    const archived = await present(archive, operationIds);
    const kept = await present(
      join(settings.directory, "journal"),
      operationIds,
    );
    if (archived === undefined || kept === undefined) return undefined;
    return turnDetails(
      {
        turns: operationIds.length,
        kept,
        archived: archived === 0 ? undefined : archive,
      },
      {
        run: Object.hasOwn(runs, runId) ? runs[runId] : undefined,
        retention: settings.retention,
        now: settings.now(),
      },
    );
  };
}

export function retentionExpiry(
  settings: Pick<TurnDetailsSettings, "retention" | "runs" | "now">,
): (runId: string) => Promise<boolean> {
  return async (runId) => {
    const runs = await settings.runs([runId]);
    return retentionExpired(
      Object.hasOwn(runs, runId) ? runs[runId] : undefined,
      { retention: settings.retention, now: settings.now() },
    );
  };
}
