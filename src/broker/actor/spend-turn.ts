import { parseCommand } from "../../authority/commands.ts";
import type { AuthorityCommand } from "../../authority/transitions.ts";
import {
  optionalText,
  text,
  type SqlConnection,
} from "../../storage/domain-rows.ts";
import { reportedPrice } from "../../worker-usage.ts";

export interface RunSpend {
  readonly spendLimitUsd: number;
  readonly recordedCostUsd: number;
}

const pinnedLimit =
  "SELECT json_extract(payload, '$.spendLimitUsd') AS spend_limit FROM events WHERE run_id = ? AND type = 'run.created' ORDER BY sequence LIMIT 1";

const turnResults =
  "SELECT d.body FROM operations o JOIN documents d ON d.digest = o.result WHERE o.run_id = ? AND o.capability = 'claude'";

const spendFields: readonly string[] = ["spendLimitUsd", "recordedCostUsd"];

function storedSpend(command: AuthorityCommand | null): {
  readonly spend?: RunSpend;
} {
  const spendLimitUsd = command?.spendLimitUsd;
  const recordedCostUsd = command?.recordedCostUsd;
  if (spendLimitUsd === undefined || recordedCostUsd === undefined) return {};
  return { spend: { spendLimitUsd, recordedCostUsd } };
}

export async function turnSpend(
  connection: SqlConnection,
  command: AuthorityCommand | null,
): Promise<{ readonly spend?: RunSpend }> {
  if (command?.kind !== "request-effect" || command.capability !== "claude")
    return {};
  const stored = await connection.get(
    "SELECT request FROM commands WHERE command_id = ?",
    [command.commandId],
  );
  if (stored !== undefined)
    return storedSpend(parseCommand(JSON.parse(text(stored, "request"))));
  const pinned = await connection.get(pinnedLimit, [command.runId]);
  const limit =
    pinned === undefined ? null : optionalText(pinned, "spend_limit");
  if (limit === null) return {};
  const results = await connection.all(turnResults, [command.runId]);
  return {
    spend: {
      spendLimitUsd: Number(limit),
      recordedCostUsd: results.reduce<number>(
        (total, row) => total + (reportedPrice(text(row, "body")) ?? 0),
        0,
      ),
    },
  };
}

export function pricedCommand(
  given: unknown,
  spend: RunSpend | undefined,
): unknown {
  const command = parseCommand(given);
  if (command?.kind !== "request-effect") return given;
  return {
    ...Object.fromEntries(
      Object.entries(command).filter(([name]) => !spendFields.includes(name)),
    ),
    ...spend,
  };
}
