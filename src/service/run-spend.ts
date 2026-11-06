import type { AuthorityCommand } from "../authority/transitions.ts";
import type { Authority } from "../broker/actor/authority.ts";
import { priceOf } from "../worker-usage.ts";
import { reportFields } from "./worker-totals.ts";

interface TurnRequest {
  readonly runId: string;
  readonly commandId: string;
  readonly capability: string;
}

interface RunSpend {
  readonly spendLimitUsd?: number;
  readonly recordedCostUsd?: number;
}

export async function pinnedSpendLimit(
  context: { readonly authority: Authority },
  runId: string,
): Promise<number | undefined> {
  const { queries } = context.authority;
  const run = await queries.run(runId);
  if (run === undefined || run.admissionCommandId === null) return undefined;
  return (await queries.receipt(run.admissionCommandId))?.command.spendLimitUsd;
}

async function recordedCostUsd(
  authority: Authority,
  runId: string,
): Promise<number> {
  let total = 0;
  for (const operation of await authority.effects.operations(runId)) {
    if (operation.capability !== "claude" || operation.result === null)
      continue;
    const report = reportFields(
      await authority.queries.document(operation.result),
    );
    total +=
      priceOf(report["costUsd"]) ?? priceOf(report["estimatedCostUsd"]) ?? 0;
  }
  return total;
}

function recordedSpend(command: AuthorityCommand): RunSpend {
  const { spendLimitUsd, recordedCostUsd } = command;
  if (spendLimitUsd === undefined || recordedCostUsd === undefined) return {};
  return { spendLimitUsd, recordedCostUsd };
}

export async function runSpend(
  authority: Authority,
  request: TurnRequest,
): Promise<RunSpend> {
  if (request.capability !== "claude") return {};
  const stored = await authority.queries.receipt(request.commandId);
  if (stored !== undefined) return recordedSpend(stored.command);
  const limit = await pinnedSpendLimit({ authority }, request.runId);
  if (limit === undefined) return {};
  return {
    spendLimitUsd: limit,
    recordedCostUsd: await recordedCostUsd(authority, request.runId),
  };
}
