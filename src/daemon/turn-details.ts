import { stat } from "node:fs/promises";
import { join } from "node:path";
import { located } from "./operation-journal.ts";
import { archiveFolder, type SweepSettings } from "./record-sweep.ts";
import {
  turnDetails,
  type RunTurns,
  type TurnDetails,
} from "../record-retention.ts";

export type TurnDetailsSettings = Pick<
  SweepSettings,
  "directory" | "retention" | "runs" | "now"
>;

async function present(
  journal: string,
  operationIds: readonly string[],
): Promise<number> {
  const found = await Promise.all(
    operationIds.map((operationId) =>
      stat(located(journal, operationId).folder).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.filter(Boolean).length;
}

export function turnDetailsPlace(
  settings: TurnDetailsSettings,
): (turns: RunTurns) => Promise<TurnDetails | undefined> {
  return async ({ runId, operationIds }) => {
    const archive = join(archiveFolder(settings), "journal");
    const runs = await settings.runs([runId]);
    const archived = await present(archive, operationIds);
    return turnDetails(
      {
        turns: operationIds.length,
        kept: await present(join(settings.directory, "journal"), operationIds),
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
