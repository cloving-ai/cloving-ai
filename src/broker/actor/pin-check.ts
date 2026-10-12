import { readExecutionManifest, resumePinned } from "../../execution-pin.ts";
import { text, type SqlConnection } from "../../storage/domain-rows.ts";
import type { AvailableManifest } from "./delivery-intents.ts";

export async function pinned(
  connection: SqlConnection,
  check: {
    readonly workflow: string;
    readonly available: AvailableManifest | undefined;
  },
): Promise<boolean> {
  const { workflow, available } = check;
  if (available === undefined) return true;
  const stored = readExecutionManifest(
    JSON.parse(
      text(
        await connection.get("SELECT manifest FROM definitions WHERE pin = ?", [
          workflow,
        ]),
        "manifest",
      ),
    ),
  );
  const current = available(stored);
  return (
    current !== undefined && resumePinned(stored, current).kind === "admitted"
  );
}
