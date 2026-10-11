import type { Database } from "solid-objects";
import type { AuthorityState } from "../authority/reducer.ts";
import { persistDecisions } from "../storage/domain-changes.ts";
import { upgradeSchema } from "../storage/domain-schema.ts";
import { decisionRows } from "./decision-restore.ts";

export async function upgradeDecisions(
  database: Database,
  state: AuthorityState,
): Promise<void> {
  await database.transaction(async (connection) => {
    await upgradeSchema(connection);
    await persistDecisions(connection, {
      ...decisionRows(state),
      documents: [],
    });
  });
}
