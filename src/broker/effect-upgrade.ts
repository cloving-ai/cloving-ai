import type { Database } from "solid-objects";
import type { AuthorityState } from "../authority/reducer.ts";
import {
  currentVersion,
  effectedVersion,
  spendingVersion,
  upgradeSchema,
} from "../storage/domain-schema.ts";
import { persistEffects } from "../storage/effect-changes.ts";
import { effectRows } from "./effect-restore.ts";

export async function upgradeEffects(
  database: Database,
  state: AuthorityState,
): Promise<void> {
  await database.transaction(async (connection) => {
    await upgradeSchema(connection, effectedVersion);
    await persistEffects(connection, effectRows(state.effects, []));
  });
}

export async function upgradeSpendingIndexes(
  database: Database,
): Promise<void> {
  await database.transaction((connection) =>
    upgradeSchema(connection, spendingVersion),
  );
}

export async function upgradeEventIndexes(database: Database): Promise<void> {
  await database.transaction((connection) =>
    upgradeSchema(connection, currentVersion),
  );
}
